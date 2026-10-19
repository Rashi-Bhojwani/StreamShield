import type {
  PlaybackEventKind,
  PlaybackFailure,
  PlaybackObservation,
} from "@streamshield/shared";

/** One local playback session. No URLs, credentials, event history or network I/O. */
export function createPlaybackObserver(
  sourceId: string,
  notify: (observation: PlaybackObservation) => void,
  clock = () => performance.now(),
) {
  const startedAt = clock();
  let startupMs: number | null = null;
  let stallCount = 0;
  let stallStarted: number | null = null;
  let stallDurationMs = 0;
  let lastTime = 0;
  let lastError: PlaybackFailure | null = null;
  let released = false;
  const closeStall = () => {
    if (stallStarted !== null) {
      stallDurationMs += Math.max(0, clock() - stallStarted);
      stallStarted = null;
    }
  };
  const record = (kind: PlaybackEventKind, error?: PlaybackFailure) => {
    if (released) return;
    if (error) lastError = { ...error };
    const now = clock();
    const observation: PlaybackObservation = {
      event: {
        kind,
        sourceId,
        at: new Date().toISOString(),
        elapsedMs: Math.max(0, now - startedAt),
        ...(error ? { error: { ...error } } : {}),
      },
      metrics: {
        sourceId,
        startupMs,
        stallCount,
        stallDurationMs:
          stallDurationMs +
          (stallStarted === null ? 0 : Math.max(0, now - stallStarted)),
        lastError: lastError ? { ...lastError } : null,
      },
    };
    // A future diagnostic subscriber must not be able to break the video lifecycle.
    try {
      notify(observation);
    } catch {
      /* Subscriber isolation. */
    }
  };
  return {
    record,
    reopen() {
      lastTime = 0;
    },
    progress(time: number, paused: boolean) {
      if (released || paused || !Number.isFinite(time) || time <= lastTime)
        return;
      lastTime = time;
      if (startupMs === null) {
        startupMs = Math.max(0, clock() - startedAt);
        record("playback_started");
      } else if (stallStarted !== null) {
        closeStall();
        record("playback_resumed");
      }
    },
    stall() {
      if (released || startupMs === null || stallStarted !== null) return;
      stallStarted = clock();
      stallCount += 1;
      record("playback_stalled");
    },
    pause() {
      closeStall();
      record("playback_paused");
    },
    end() {
      closeStall();
      record("playback_ended");
    },
    release() {
      if (released) return;
      closeStall();
      record("source_released");
      released = true;
    },
  };
}
