import { describe, expect, it } from "vitest";
import type { PlaybackObservation } from "@streamshield/shared";
import { createPlaybackObserver } from "./observability";

describe("measured playback observations", () => {
  it("does not invent startup from a manifest and measures deduplicated stalls excluding pauses", () => {
    let now = 100;
    const samples: PlaybackObservation[] = [];
    const observer = createPlaybackObserver(
      "channel-a",
      (sample) => samples.push(sample),
      () => now,
    );
    observer.record("player_initialized");
    observer.record("manifest_loaded");
    observer.stall();
    expect(samples.at(-1)?.metrics).toMatchObject({
      startupMs: null,
      stallCount: 0,
    });
    now = 350;
    observer.progress(1, false);
    expect(samples.at(-1)).toMatchObject({
      event: { kind: "playback_started", sourceId: "channel-a" },
      metrics: { startupMs: 250 },
    });
    now = 500;
    observer.stall();
    now = 700;
    observer.stall();
    observer.progress(1, false);
    expect(samples.at(-1)?.event.kind).toBe("playback_stalled");
    now = 900;
    observer.progress(2, false);
    expect(samples.at(-1)).toMatchObject({
      event: { kind: "playback_resumed" },
      metrics: { stallCount: 1, stallDurationMs: 400 },
    });
    now = 1000;
    observer.stall();
    now = 1100;
    observer.pause();
    now = 3000;
    observer.progress(3, true);
    observer.progress(3, false);
    observer.stall();
    observer.reopen();
    now = 3100;
    observer.progress(1, false);
    expect(samples.at(-1)?.event.kind).toBe("playback_resumed");
    observer.release();
    expect(samples.at(-1)?.metrics).toMatchObject({
      startupMs: 250,
      stallCount: 3,
      stallDurationMs: 600,
    });
  });
  it("keeps the last error after recovery, snapshots immutable and shuts down notifications on release", () => {
    let now = 0;
    const samples: PlaybackObservation[] = [];
    const observer = createPlaybackObserver(
      "live",
      (sample) => samples.push(sample),
      () => now,
    );
    const error = {
      code: "fragLoadError",
      message: "Segment failed",
      fatal: false,
    };
    observer.record("segment_failure", error);
    error.message = "mutated by caller";
    now = 10;
    observer.progress(1, false);
    expect(samples[0]?.metrics.startupMs).toBeNull();
    expect(samples.at(-1)?.metrics.lastError?.message).toBe("Segment failed");
    observer.release();
    const count = samples.length;
    observer.record("manifest_loaded");
    observer.stall();
    observer.progress(2, false);
    observer.release();
    expect(samples).toHaveLength(count);
  });
});
