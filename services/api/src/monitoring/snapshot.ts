import {
  observationFreshness,
  type ComponentObservation,
  type MediaObservation,
  type MonitoringSnapshot,
} from "@streamshield/shared";
export function liveSnapshot(
  frame: {
    components: ComponentObservation[];
    media: MediaObservation[];
    mediaAvailable: boolean;
    lastCompleted: number;
    persistence: boolean;
    staleAfterMs: number;
  },
  durable?: MonitoringSnapshot,
  now = Date.now(),
  historyReadable = true,
): MonitoringSnapshot {
  const stale =
    !frame.lastCompleted ||
    observationFreshness(frame.lastCompleted, now, frame.staleAfterMs) !==
      "fresh" ||
    frame.components.some(
      (c) =>
        observationFreshness(c.observedAt, now, frame.staleAfterMs) !== "fresh",
    );
  return {
    version: 1,
    serverTime: new Date(now).toISOString(),
    sequence: durable?.sequence || "0",
    observedAt: frame.lastCompleted
      ? new Date(frame.lastCompleted).toISOString()
      : null,
    durableObservedAt: durable?.observedAt || null,
    staleAfterMs: frame.staleAfterMs,
    stale,
    persistence: frame.persistence,
    incidentHistoryAvailable:
      !!durable &&
      historyReadable &&
      observationFreshness(durable.observedAt, now, frame.staleAfterMs) ===
        "fresh",
    components: frame.components,
    media: frame.media,
    mediaAvailable: frame.mediaAvailable,
    incidents: durable?.incidents || [],
    openCount: durable?.openCount || 0,
    verifiedCount: durable?.verifiedCount || 0,
    playback: {
      reports: 0,
      advancing: 0,
      standby: 0,
      checkedAt: null,
      label: "No recent browser observations",
    },
  };
}
