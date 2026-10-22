import { useCallback, useEffect, useRef, useState } from "react";
import { type Publishing, publishingSchema } from "@streamshield/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "./auth-context";
import { publishWhip } from "./whip";

export function BrowserStudio({
  streamId,
  live,
}: {
  streamId: string;
  live: boolean;
}) {
  const auth = useAuth(),
    cache = useQueryClient();
  const preview = useRef<HTMLVideoElement>(null);
  const capture = useRef<MediaStream | null>(null);
  const publisher = useRef<Awaited<ReturnType<typeof publishWhip>> | null>(
    null,
  );
  const attempt = useRef(0);
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
        setReady(false);
        setState("Capture stopped. End the broadcast or select a new source.");
        void publisher.current?.close();
        publisher.current = null;
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
  const start = async () => {
    if (!capture.current || busy || publishing) return;
    const source = capture.current;
    const current = ++attempt.current;
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
      if (attempt.current !== current) return;
      const connection = await publishWhip(source, key, (s) => {
        if (attempt.current === current)
          setState(
            s === "connected"
              ? "Publishing media · waiting for verified LIVE status"
              : s === "disconnected"
                ? "Connection lost · reconnecting"
                : s === "failed"
                  ? "Connection failed · check your network"
                  : "Connection: " + s,
          );
      });
      if (attempt.current !== current) {
        await connection.close();
        return;
      }
      publisher.current = connection;
      setPublishing(true);
      await cache.invalidateQueries({ queryKey: ["studio"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Publishing failed.");
    } finally {
      setBusy(false);
    }
  };
  const end = async () => {
    setBusy(true);
    setError("");
    attempt.current++;
    try {
      await publisher.current?.close();
      publisher.current = null;
      setPublishing(false);
      await auth.call("/studio/streams/" + streamId + "/end", {
        method: "POST",
      });
      release();
      setReady(false);
      setState("Broadcast ended.");
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
      <video
        className="camera-preview"
        ref={preview}
        muted
        playsInline
        aria-label="Local camera preview"
      />
      <p className="fine-print">
        Local preview stays private until you press Start Live. Your broadcast
        appears publicly only after media is verified.
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
          Preview camera
        </button>
        <button
          className="button secondary"
          disabled={publishing || busy}
          onClick={() => void prepare(true)}
        >
          Share screen
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
          Start Live
        </button>
        <button
          className="button secondary danger-button"
          disabled={!publishing || busy}
          onClick={() => void end()}
        >
          End Live
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
      <p role="status">{state}</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
