import type { Publishing } from "@streamshield/shared";

export function whipResource(
  location: string,
  endpoint: string,
  origin = window.location.origin,
) {
  const base = new URL(endpoint, origin);
  const url = new URL(location, base);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith(base.pathname + "/")
  )
    throw new Error(
      "The publishing service returned an invalid session address.",
    );
  return url.toString();
}

export async function publishWhip(
  stream: MediaStream,
  publishing: Publishing,
  onState: (state: RTCPeerConnectionState) => void,
  signal?: AbortSignal,
) {
  if (!publishing.whipUrl)
    throw new Error(
      "Browser publishing is unavailable in this deployment. Use OBS.",
    );
  const pc = new RTCPeerConnection({ iceServers: [] });
  let resource: string | undefined;
  const auth = "Basic " + btoa(publishing.user + ":" + publishing.key);
  const close = async () => {
    pc.close();
    if (resource) {
      const url = resource;
      resource = undefined;
      await fetch(url, {
        method: "DELETE",
        headers: { Authorization: auth },
        credentials: "omit",
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      }).catch(() => {});
    }
  };
  try {
    signal?.throwIfAborted();
    pc.onconnectionstatechange = () => onState(pc.connectionState);
    for (const track of stream.getTracks()) {
      const transceiver = pc.addTransceiver(track, {
        direction: "sendonly",
        streams: [stream],
      });
      const capabilities = RTCRtpSender.getCapabilities(track.kind);
      const codecs =
        capabilities?.codecs.filter(
          (c) =>
            c.mimeType.toLowerCase() ===
            (track.kind === "video" ? "video/h264" : "audio/opus"),
        ) || [];
      if (!codecs.length)
        throw new Error(
          `This browser cannot publish ${track.kind === "video" ? "H.264 video" : "Opus audio"}. Use a compatible Chrome/Edge browser or OBS.`,
        );
      transceiver.setCodecPreferences(codecs);
    }
    await pc.setLocalDescription(await pc.createOffer());
    if (pc.iceGatheringState !== "complete")
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pc.removeEventListener("icegatheringstatechange", check);
          reject(
            new Error("ICE candidate gathering timed out. Check your network."),
          );
        }, 10000);
        function check() {
          if (pc.iceGatheringState === "complete") {
            clearTimeout(timer);
            pc.removeEventListener("icegatheringstatechange", check);
            resolve();
          }
        }
        pc.addEventListener("icegatheringstatechange", check);
        check();
      });
    const response = await fetch(publishing.whipUrl, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/sdp" },
      body: pc.localDescription!.sdp,
      credentials: "omit",
      signal: AbortSignal.any([
        AbortSignal.timeout(15000),
        ...(signal ? [signal] : []),
      ]),
      redirect: "error",
    });
    if (response.status !== 201)
      throw new Error(
        response.status === 401 || response.status === 403
          ? `Publishing authorization rejected (${response.status}). Refresh your login and create a new broadcast; keep its key private.`
          : `Publishing negotiation failed (${response.status}). Check dynamic:status and the /ingest proxy; rerun setup:dynamic and recreate services after updating.`,
      );
    const location = response.headers.get("Location");
    if (!location) throw new Error("Publishing session address is missing.");
    resource = whipResource(location, publishing.whipUrl);
    await pc.setRemoteDescription({
      type: "answer",
      sdp: await response.text(),
    });
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        pc.removeEventListener("connectionstatechange", check);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (pc.connectionState === "connected") finish();
        else if (["failed", "closed"].includes(pc.connectionState))
          finish(
            new Error(
              "Media connection failed. Check Docker Desktop, VPN/firewall and BROWSER_ICE_PORT UDP/TCP forwarding.",
            ),
          );
      };
      const abort = () => finish(new Error("Publishing cancelled."));
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              "Media connection timed out: WHIP accepted the request but ICE could not connect. Check BROWSER_ICE_PORT UDP/TCP, firewall/VPN and the advertised ICE host. Local preview is not a broadcast.",
            ),
          ),
        20000,
      );
      pc.addEventListener("connectionstatechange", check);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else check();
    });
    return { close, stats: () => pc.getStats() };
  } catch (e) {
    await close();
    throw e;
  }
}
