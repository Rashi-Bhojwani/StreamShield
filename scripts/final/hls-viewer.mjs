// Headless HLS viewer: fetches the stream through the same public path a browser
// uses (web -> video gateway -> edge), decodes every new segment with ffprobe and
// records decoded frames, segment sequence, the serving edge (X-Edge-ID) and stalls.
// Labelled "ffprobe-decoded", never "browser-observed".
import { spawn } from "node:child_process";

function decodedFrames(bytes) {
  return new Promise((resolve) => {
    const p = spawn(
      process.env.FFPROBE_PATH || "ffprobe",
      [
        "-v",
        "error",
        "-count_frames",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=nb_read_frames",
        "-of",
        "csv=p=0",
        "-i",
        "pipe:0",
      ],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => resolve(Number.parseInt(out, 10) || 0));
    p.on("error", () => resolve(0));
    p.stdin.on("error", () => {});
    p.stdin.end(bytes);
  });
}
async function get(url, timeoutMs) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok)
    throw Object.assign(new Error("http " + r.status), { status: r.status });
  return {
    body: Buffer.from(await r.arrayBuffer()),
    edge: r.headers.get("x-edge-id"),
    cache: r.headers.get("x-cache"),
  };
}
/**
 * @param {{ base: string, sources: {id: string, url: string}[], intervalMs?: number,
 *           stallThresholdMs?: number }} options  sources: primary first, then standby.
 */
export function startViewer({
  base,
  sources,
  intervalMs = 1000,
  stallThresholdMs = 4000,
}) {
  const state = {
    startedAt: Date.now(),
    frames: 0,
    segments: 0,
    lastSequence: null,
    lastProgressAt: null,
    source: sources[0].id,
    sourceSwitches: [],
    edges: [],
    stalls: [],
    errors: 0,
    samples: [],
    /** Serving edge of every response (playlists and segments), newest last. */
    responses: [],
  };
  const note = (edge) => {
    if (!edge) return;
    state.responses.push({ edge, at: Date.now() });
    if (state.responses.length > 500) state.responses.shift();
  };
  let stopped = false,
    init = null,
    initUri = null,
    stallStart = null,
    active = 0;
  const seen = new Set();
  const mark = (now) => {
    if (state.lastProgressAt && now - state.lastProgressAt >= stallThresholdMs)
      stallStart ??= state.lastProgressAt;
  };
  async function tick() {
    const now = Date.now();
    const src = sources[active];
    try {
      const master = (
        await get(new URL(src.url, base).href, 4000)
      ).body.toString();
      const variantPath = master
        .split("\n")
        .find((l) => l.trim() && !l.startsWith("#") && l.includes("video"));
      if (!variantPath) throw new Error("no variant");
      const variantUrl = new URL(variantPath.trim(), new URL(src.url, base));
      const variantResponse = await get(variantUrl.href, 4000);
      note(variantResponse.edge);
      const playlist = variantResponse.body.toString();
      const map = /#EXT-X-MAP:URI="([^"]+)"/.exec(playlist)?.[1];
      if (map && map !== initUri) {
        init = (await get(new URL(map, variantUrl).href, 4000)).body;
        initUri = map;
      }
      const first = Number(
        /#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(playlist)?.[1] ?? 0,
      );
      const uris = playlist
        .split("\n")
        .filter((l) => l.trim() && !l.startsWith("#"));
      // Live edge only: the newest two segments, like a player near live.
      for (const [i, uri] of uris.entries()) {
        const seq = first + i;
        if (i < uris.length - 2 || seen.has(src.id + seq)) continue;
        seen.add(src.id + seq);
        const seg = await get(new URL(uri.trim(), variantUrl).href, 6000);
        note(seg.edge);
        const frames = init
          ? await decodedFrames(Buffer.concat([init, seg.body]))
          : 0;
        const at = Date.now();
        if (seg.edge && state.edges.at(-1)?.edge !== seg.edge)
          state.edges.push({ edge: seg.edge, at: new Date(at).toISOString() });
        if (frames > 0) {
          if (stallStart !== null) {
            state.stalls.push({
              from: new Date(stallStart).toISOString(),
              to: new Date(at).toISOString(),
              durationMs: at - stallStart,
            });
            stallStart = null;
          }
          state.frames += frames;
          state.segments++;
          state.lastSequence = seq;
          state.lastProgressAt = at;
        }
        state.samples.push({ at, seq, frames, edge: seg.edge, source: src.id });
        if (state.samples.length > 2000) state.samples.shift();
      }
    } catch {
      state.errors++;
      // Like the player: after repeated primary failure, try the standby path.
      if (
        sources.length > 1 &&
        active === 0 &&
        state.lastProgressAt &&
        now - state.lastProgressAt > 6000
      ) {
        active = 1;
        state.source = sources[1].id;
        state.sourceSwitches.push({
          to: sources[1].id,
          at: new Date(now).toISOString(),
        });
      }
    }
    mark(Date.now());
  }
  const loop = (async () => {
    while (!stopped) {
      const started = Date.now();
      await tick();
      await new Promise((r) =>
        setTimeout(r, Math.max(100, intervalMs - (Date.now() - started))),
      );
    }
  })();
  return {
    state,
    /** Frames decoded since a mark; used to assert "still advancing". */
    snapshot: () => ({
      frames: state.frames,
      seq: state.lastSequence,
      at: Date.now(),
    }),
    preferPrimary() {
      active = 0;
      state.source = sources[0].id;
    },
    stalledFor: () => (stallStart !== null ? Date.now() - stallStart : 0),
    async stop() {
      stopped = true;
      await loop;
      if (stallStart !== null)
        state.stalls.push({
          from: new Date(stallStart).toISOString(),
          to: null,
          durationMs: Date.now() - stallStart,
        });
      return state;
    },
  };
}
