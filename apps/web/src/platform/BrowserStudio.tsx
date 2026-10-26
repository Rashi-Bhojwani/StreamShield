import { Icon } from "../ui/Icon";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Publishing, publishingSchema } from "@streamshield/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "./auth-context";
import { publishWhip } from "./whip";
import { verifyBroadcast } from "./verify-broadcast";

export function BrowserStudio({
  streamId,
  live,
  onNotice,
}: {
  streamId: string;
  live: boolean;
  onNotice: (notice: string) => void;
}) {
  const auth = useAuth(),
    cache = useQueryClient();
  const preview = useRef<HTMLVideoElement>(null);
  const capture = useRef<MediaStream | null>(null);
  const publisher = useRef<Awaited<ReturnType<typeof publishWhip>> | null>(
    null,
  );
  const attempt = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const connected = useRef(false);
  const reconnecting = useRef(false);
  const lostTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]),
    [camera, setCamera] = useState(""),
    [microphone, setMicrophone] = useState("");
  const [state, setState] = useState("Preview is off"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [publishing, setPublishing] = useState(false),
    [level, setLevel] = useState(0);
  const [muted, setMuted] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  useEffect(() => {
    if (!publishing) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [publishing]);
  const audio = useRef<AudioContext | null>(null),
    meterTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const release = useCallback(() => {
    capture.current?.getTracks().forEach((t) => t.stop());
    capture.current = null;
    if (meterTimer.current) clearInterval(meterTimer.current);
    void audio.current?.close();
    audio.current = null;
    if (preview.current) preview.current.srcObject = null;
  }, []);
  useEffect(
    () => () => {
      attempt.current++;
      pending.current?.abort();
      void publisher.current?.close();
      release();
    },
    [release],
  );
  const prepare = async (screen: boolean) => {
    if (busy || publisher.current) return;
    const current = ++attempt.current;
    setBusy(true);
    setError("");
    release();
    setReady(false);
    try {
      if (!window.isSecureContext || !navigator.mediaDevices)
        throw new Error(
          "Camera and screen sharing require localhost or an HTTPS secure context.",
        );
      const video = screen
        ? await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: 30 },
            audio: false,
          })
        : await navigator.mediaDevices.getUserMedia({
            video: {
              deviceId: camera ? { exact: camera } : undefined,
              width: { ideal: 1280 },
              height: { ideal: 720 },
              frameRate: { ideal: 30 },
            },
            audio: false,
          });
      if (attempt.current !== current) {
        video.getTracks().forEach((t) => t.stop());
        return;
      }
      capture.current = video;
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: microphone ? { exact: microphone } : undefined,
          echoCancellation: true,
        },
        video: false,
      });
      if (attempt.current !== current) {
        mic.getTracks().forEach((t) => t.stop());
        video.getTracks().forEach((t) => t.stop());
        return;
      }
      mic.getAudioTracks().forEach((t) => video.addTrack(t));
      for (const t of video.getAudioTracks()) t.enabled = !muted;
      if (preview.current) {
        preview.current.srcObject = video;
        await preview.current.play();
      }
      setDevices(await navigator.mediaDevices.enumerateDevices());
      const context = new AudioContext();
      audio.current = context;
      await context.resume();
      const analyser = context.createAnalyser();
      context.createMediaStreamSource(video).connect(analyser);
      analyser.fftSize = 256;
      const data = new Uint8Array(analyser.fftSize);
      meterTimer.current = setInterval(() => {
        analyser.getByteTimeDomainData(data);
        setLevel(
          Math.min(
            100,
            Math.round(
              Math.sqrt(
                data.reduce((sum, v) => sum + ((v - 128) / 128) ** 2, 0) /
                  data.length,
              ) * 300,
            ),
          ),
        );
      }, 150);
      video.getVideoTracks()[0]!.onended = () => {
        if (publisher.current || pending.current) {
          void end(
            "Capture stopped. The broadcast has ended; create a new livestream to publish again.",
          );
          return;
        }
        setReady(false);
        setState("Capture stopped. End the broadcast or select a new source.");
        release();
        setPublishing(false);
      };
      setReady(true);
      setState(
        screen
          ? "Screen and microphone preview ready"
          : "Camera and microphone preview ready",
      );
    } catch (e) {
      release();
      setError(
        e instanceof Error
          ? e.message
          : "Unable to access devices. Check camera and microphone permissions.",
      );
    } finally {
      setBusy(false);
    }
  };
  /**
   * The broadcaster client heals its own connection: after the ingest server
   * drops, republish on the same key with bounded backoff. This is the client
   * reconnecting itself; the server side is restored by the Healer.
   */
  const RECONNECT_LIMIT = 8;
  const reconnect = async (key: Publishing, current: number) => {
    if (reconnecting.current || attempt.current !== current) return;
    reconnecting.current = true;
    connected.current = false;
    const old = publisher.current;
    publisher.current = null;
    void old?.close();
    for (let i = 1; i <= RECONNECT_LIMIT; i++) {
      if (attempt.current !== current || !capture.current) break;
      setReconnectAttempt(i);
      setState(
        `Connection to server lost · reconnecting (attempt ${i} of ${RECONNECT_LIMIT})`,
      );
      await new Promise((r) => setTimeout(r, Math.min(500 * i, 3000)));
      if (attempt.current !== current || !capture.current) break;
      try {
        const connection = await publishWhip(
          capture.current,
          key,
          watch(key, current),
        );
        if (attempt.current !== current) {
          await connection.close();
          break;
        }
        publisher.current = connection;
        connected.current = true;
        reconnecting.current = false;
        setReconnectAttempt(0);
        setState(
          "Reconnected · publishing again (this browser reconnected itself)",
        );
        onNotice("Broadcast connection restored automatically.");
        return;
      } catch {
        /* Next bounded attempt. */
      }
    }
    reconnecting.current = false;
    setReconnectAttempt(0);
    if (attempt.current === current)
      void end(
        `The connection could not be re-established after ${RECONNECT_LIMIT} attempts. This publishing attempt was stopped.`,
        key.key,
      );
  };
  const watch =
    (key: Publishing, current: number) => (s: RTCPeerConnectionState) => {
      if (attempt.current !== current || reconnecting.current) return;
      if (lostTimer.current) {
        clearTimeout(lostTimer.current);
        lostTimer.current = null;
      }
      setState(
        s === "connected"
          ? "Publishing media · waiting for verified LIVE status"
          : s === "disconnected"
            ? "Connection to server lost · reconnecting"
            : s === "failed"
              ? "Connection to server lost · reconnecting"
              : "Connection: " + s,
      );
      if (!connected.current) return;
      if (s === "failed") void reconnect(key, current);
      // ICE "disconnected" can heal itself; republish if it has not within 3 s.
      else if (s === "disconnected")
        lostTimer.current = setTimeout(
          () => void reconnect(key, current),
          3000,
        );
    };
  const start = async () => {
    if (!capture.current || busy || publishing) return;
    const source = capture.current;
    const current = ++attempt.current;
    const controller = new AbortController();
    pending.current = controller;
    let allocatedKey: string | undefined;
    setBusy(true);
    setError("");
    setState("Preparing publishing connection…");
    try {
      if (
        live &&
        !window.confirm(
          "This broadcast already has a publisher. Replace its publishing key and disconnect it?",
        )
      )
        return;
      const key: Publishing = publishingSchema.parse(
        await auth.call("/studio/streams/" + streamId + "/publishing", {
          method: "POST",
        }),
      );
      allocatedKey = key.key;
      controller.signal.throwIfAborted();
      setHasSession(true);
      const connection = await publishWhip(
        source,
        key,
        watch(key, current),
        controller.signal,
      );
      if (attempt.current !== current) {
        await connection.close();
        return;
      }
      publisher.current = connection;
      connected.current = true;
      setPublishing(true);
      await verifyBroadcast(
        (signal) => auth.call("/streams/" + streamId + "/status", { signal }),
        controller.signal,
      );
      setState("Live · your broadcast is available to viewers.");
      await cache.invalidateQueries({ queryKey: ["studio"] });
    } catch (e) {
      if (controller.signal.reason === "owner-ended") return;
      connected.current = false;
      await publisher.current?.close();
      publisher.current = null;
      setPublishing(false);
      let message = e instanceof Error ? e.message : "Publishing failed.";
      if (allocatedKey) {
        try {
          const result = await auth.call<{ stopped: boolean }>(
            "/studio/streams/" + streamId + "/publishing/cancel",
            {
              method: "POST",
              body: JSON.stringify({ key: allocatedKey }),
            },
          );
          setHasSession(false);
          message += result.stopped
            ? " Publishing stopped. Create a new livestream to retry."
            : " This attempt was replaced; the newer publisher was left running.";
        } catch {
          message +=
            " Server cleanup could not be confirmed. Use End Live or End stream once services recover.";
        }
      }
      setError(message);
      onNotice(message);
      setState("Publishing failed · preview is not live");
      await cache.invalidateQueries({ queryKey: ["studio"] });
    } finally {
      if (pending.current === controller) pending.current = null;
      setBusy(false);
    }
  };
  const end = async (notice = "Broadcast ended.", expectedKey?: string) => {
    setBusy(true);
    setError("");
    attempt.current++;
    pending.current?.abort("owner-ended");
    connected.current = false;
    try {
      await publisher.current?.close();
      publisher.current = null;
      setPublishing(false);
      const result = await auth.call<{ stopped?: boolean }>(
        "/studio/streams/" +
          streamId +
          (expectedKey ? "/publishing/cancel" : "/end"),
        {
          method: "POST",
          ...(expectedKey
            ? { body: JSON.stringify({ key: expectedKey }) }
            : {}),
        },
      );
      if (result.stopped === false)
        notice += " A newer publishing attempt was left running.";
      setHasSession(false);
      release();
      setReady(false);
      setState(notice);
      onNotice(notice);
      await cache.invalidateQueries({ queryKey: ["studio"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "End could not be confirmed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="browser-studio" aria-label="Browser broadcasting">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Camera or screen</p>
          <h4>Go live from your browser</h4>
        </div>
        <span className="subtle-chip">
          {live ? "Verified LIVE" : publishing ? "Publishing" : "Preview only"}
        </span>
      </div>
      <div className="capture-stage">
        <video
          className="camera-preview"
          ref={preview}
          muted
          playsInline
          aria-label="Local camera preview"
        />
        <div className="capture-stage-hud">
          <span
            className={"capture-state " + (live && publishing ? "is-live" : "")}
          >
            <span className="record-dot" />
            {live && publishing
              ? "ON AIR"
              : publishing
                ? "CONNECTING"
                : "PREVIEW"}
          </span>
          <span>StreamShield Studio</span>
        </div>
        {!ready && !publishing && (
          <div className="capture-placeholder">
            <span>
              <Icon name="studio" />
            </span>
            <h4>Make this moment yours.</h4>
            <p>Preview your camera or share your screen to set the scene.</p>
          </div>
        )}
        <div className="capture-stage-footer">
          <span>{muted ? "Microphone muted" : "Microphone on"}</span>
          <span>
            {publishing ? "Keep this tab open" : "Preview stays private"}
          </span>
        </div>
      </div>
      <p className="fine-print">
        Preview stays private until you go live. Keep this Studio tab open; open
        your watch page in a separate tab.
      </p>
      <div className="device-grid">
        <label>
          Camera
          <select
            value={camera}
            disabled={publishing || busy}
            onChange={(e) => setCamera(e.target.value)}
          >
            <option value="">Default camera</option>
            {devices
              .filter((d) => d.kind === "videoinput")
              .map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || "Camera"}
                </option>
              ))}
          </select>
        </label>
        <label>
          Microphone
          <select
            value={microphone}
            disabled={publishing || busy}
            onChange={(e) => setMicrophone(e.target.value)}
          >
            <option value="">Default microphone</option>
            {devices
              .filter((d) => d.kind === "audioinput")
              .map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || "Microphone"}
                </option>
              ))}
          </select>
        </label>
      </div>
      <p className="fine-print">
        After changing a device, select Preview camera again.
      </p>
      <label className="mic-meter">
        Microphone level <meter min={0} max={100} value={level} />
      </label>
      <div className="studio-actions">
        <button
          className="button secondary"
          disabled={publishing || busy}
          onClick={() => void prepare(false)}
        >
          <Icon name="studio" /> Preview camera
        </button>
        <button
          className="button secondary"
          disabled={publishing || busy}
          onClick={() => void prepare(true)}
        >
          <Icon name="share" /> Share screen
        </button>
        <button
          className="button secondary"
          disabled={!ready}
          onClick={() => {
            const next = !muted;
            setMuted(next);
            capture.current
              ?.getAudioTracks()
              .forEach((t) => (t.enabled = !next));
          }}
        >
          {muted ? "Unmute microphone" : "Mute microphone"}
        </button>
        <button
          className="button primary"
          disabled={!ready || publishing || busy}
          onClick={() => void start()}
        >
          <Icon name="live" /> Start Live
        </button>
        <button
          className="button secondary danger-button"
          disabled={!hasSession}
          onClick={() => void end()}
        >
          <Icon name="close" /> End Live
        </button>
        <button
          className="text-link"
          disabled={publishing || busy || !ready}
          onClick={() => {
            release();
            setReady(false);
            setState("Preview is off");
          }}
        >
          Stop preview
        </button>
      </div>
      <p
        role="status"
        data-testid="studio-publish-state"
        className={reconnectAttempt ? "studio-reconnecting" : undefined}
      >
        {live && publishing && !reconnectAttempt
          ? "Live · your broadcast is available to viewers."
          : state}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
