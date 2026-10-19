import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import type { PlaybackObservation } from "@streamshield/shared";
import { createPlaybackObserver } from "./observability";
import { config } from "../config";

export type PlaybackState =
  | "loading"
  | "playing"
  | "paused"
  | "buffering"
  | "blocked"
  | "reconnecting"
  | "error"
  | "unsupported";
function retryDelay(attempt: number) {
  return Math.min(
    config.VITE_PLAYER_RETRY_BASE_MS * 2 ** (attempt - 1),
    config.VITE_PLAYER_RETRY_MAX_MS,
  );
}

export function LivePlayer({
  source,
  sourceId = "unidentified-source",
  onObservation,
}: {
  source: string;
  sourceId?: string;
  onObservation?: (observation: PlaybackObservation) => void;
}) {
  const subscriber = useRef(onObservation);
  useEffect(() => {
    subscriber.current = onObservation;
  }, [onObservation]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [session, setSession] = useState(0);
  const [state, setState] = useState<PlaybackState>("loading");
  const [detail, setDetail] = useState("Waiting for video data.");
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const observer = createPlaybackObserver(sourceId, (observation) =>
      subscriber.current?.(observation),
    );
    observer.record("player_initialized");
    let disposed = false;
    let hls: Hls | undefined;
    let attempts = 0;
    let lastTime = -1;
    let recovering = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const update = (next: PlaybackState, message: string) => {
      if (!disposed) {
        setState(next);
        setDetail(message);
      }
    };
    const clearStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = undefined;
    };
    const detach = () => {
      hls?.destroy();
      hls = undefined;
      video.removeAttribute("src");
      video.load();
    };
    const retry = (reason: string) => {
      if (disposed || recovering) return;
      recovering = true;
      observer.stall();
      clearStall();
      detach();
      if (attempts >= config.VITE_PLAYER_RETRY_LIMIT) {
        observer.record("fatal_player_error", {
          code: "retry_budget_exhausted",
          message: reason,
          fatal: true,
        });
        update("error", `${reason} Automatic retry budget exhausted.`);
        return;
      }
      attempts += 1;
      observer.record("retry_scheduled");
      update(
        "reconnecting",
        `${reason} Retry ${attempts} of ${config.VITE_PLAYER_RETRY_LIMIT}.`,
      );
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        recovering = false;
        update("loading", "Reopening the HLS source…");
        attach();
      }, retryDelay(attempts));
    };
    const watchStall = () => {
      if (stallTimer) return;
      stallTimer = setTimeout(
        () => retry("Video data stopped progressing."),
        config.VITE_PLAYER_STALL_TIMEOUT_MS,
      );
    };
    const play = () => {
      void video.play().catch((error: unknown) => {
        if (disposed || recovering) return;
        const errorName =
          typeof error === "object" && error !== null && "name" in error
            ? String(error.name)
            : "";
        if (errorName === "AbortError") return;
        if (errorName === "NotAllowedError") {
          clearStall();
          observer.record("autoplay_blocked", {
            code: "autoplay_blocked",
            message: "Browser requires user interaction.",
            fatal: false,
          });
          update(
            "blocked",
            "Playback requires your interaction. Use the video play control.",
          );
        } else {
          retry(
            "Playback could not start. Check source codecs and browser support.",
          );
        }
      });
    };
    const playing = () => {
      if (!recovering) {
        update("playing", "The browser is playing video.");
        watchStall();
      }
    };
    const progress = () => {
      if (!recovering && !video.paused && video.currentTime > lastTime) {
        observer.progress(video.currentTime, video.paused);
        lastTime = video.currentTime;
        clearStall();
        watchStall();
      }
    };
    const buffering = () => {
      if (!recovering) {
        if (!video.paused) observer.stall();
        update("buffering", "Waiting for additional media data.");
        watchStall();
      }
    };
    const paused = () => {
      if (!recovering) {
        clearStall();
        observer.pause();
        update(
          "paused",
          "Playback paused. Use the video play control to resume.",
        );
      }
    };
    const mediaError = () => {
      observer.record("fatal_player_error", {
        code: "browser_media_error",
        message: "The browser reported a media error.",
        fatal: true,
      });
      retry("The browser reported a media error.");
    };
    const ended = () => {
      observer.end();
      retry("The live media source ended.");
    };
    const nativeReady = () => {
      observer.record("native_media_ready");
      play();
    };
    const attach = () => {
      if (disposed) return;
      lastTime = -1;
      observer.reopen();
      if (Hls.isSupported()) {
        const policy = {
          default: {
            maxTimeToFirstByteMs: config.VITE_PLAYER_LOAD_TIMEOUT_MS,
            maxLoadTimeMs: config.VITE_PLAYER_LOAD_TIMEOUT_MS,
            timeoutRetry: null,
            errorRetry: null,
          },
        };
        hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          manifestLoadPolicy: policy,
          playlistLoadPolicy: policy,
          fragLoadPolicy: policy,
        });
        hls.on(Hls.Events.MANIFEST_LOADED, () =>
          observer.record("manifest_loaded"),
        );
        hls.on(Hls.Events.MANIFEST_PARSED, play);
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (disposed || recovering) return;
          const failure = {
            code: data.details,
            message: "HLS media delivery reported an error.",
            fatal: data.fatal,
          };
          if (
            [
              Hls.ErrorDetails.MANIFEST_LOAD_ERROR,
              Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT,
              Hls.ErrorDetails.MANIFEST_PARSING_ERROR,
              Hls.ErrorDetails.LEVEL_LOAD_ERROR,
              Hls.ErrorDetails.LEVEL_LOAD_TIMEOUT,
            ].includes(data.details)
          )
            observer.record("manifest_failure", failure);
          if (
            [
              Hls.ErrorDetails.FRAG_LOAD_ERROR,
              Hls.ErrorDetails.FRAG_LOAD_TIMEOUT,
              Hls.ErrorDetails.FRAG_PARSING_ERROR,
            ].includes(data.details)
          )
            observer.record("segment_failure", failure);
          if (data.response?.code === 404 || data.response?.code === 410)
            observer.record("source_unavailable", failure);
          if (data.fatal) observer.record("fatal_player_error", failure);
          if (data.fatal)
            retry(
              data.type === Hls.ErrorTypes.MEDIA_ERROR
                ? "Media decoding failed."
                : "HLS delivery failed.",
            );
        });
        hls.loadSource(source);
        hls.attachMedia(video);
        watchStall();
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = source;
        video.addEventListener("loadedmetadata", nativeReady);
        watchStall();
      } else {
        observer.record("fatal_player_error", {
          code: "unsupported_browser",
          message: "No supported HLS playback capability.",
          fatal: true,
        });
        update(
          "unsupported",
          "This browser supports neither MediaSource HLS nor native HLS. Try a current supported browser.",
        );
      }
    };
    video.addEventListener("playing", playing);
    video.addEventListener("timeupdate", progress);
    video.addEventListener("waiting", buffering);
    video.addEventListener("stalled", buffering);
    video.addEventListener("pause", paused);
    video.addEventListener("error", mediaError);
    video.addEventListener("ended", ended);
    attach();
    return () => {
      disposed = true;
      observer.release();
      clearStall();
      if (retryTimer) clearTimeout(retryTimer);
      video.removeEventListener("playing", playing);
      video.removeEventListener("timeupdate", progress);
      video.removeEventListener("waiting", buffering);
      video.removeEventListener("stalled", buffering);
      video.removeEventListener("pause", paused);
      video.removeEventListener("error", mediaError);
      video.removeEventListener("ended", ended);
      video.removeEventListener("loadedmetadata", nativeReady);
      detach();
    };
  }, [source, sourceId, session]);
  return (
    <div className="player">
      <video
        ref={videoRef}
        controls
        muted
        playsInline
        preload="none"
        aria-label="Live stream video"
      />
      <div className="playback-bar">
        <span
          className={`status-dot ${state === "playing" ? "ready" : state === "error" || state === "unsupported" ? "error" : "pending"}`}
        />
        <strong data-testid="playback-state">{state}</strong>
        <span role="status">{detail}</span>
        {state === "error" && (
          <button
            className="text-button"
            onClick={() => {
              setState("loading");
              setDetail("Starting a new playback session…");
              setSession((n) => n + 1);
            }}
          >
            Retry playback
          </button>
        )}
      </div>
      <p className="player-note">
        Starts muted. Use the player controls for sound, pause and fullscreen.
      </p>
    </div>
  );
}
