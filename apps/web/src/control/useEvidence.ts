import { useQuery } from "@tanstack/react-query";
import type { ChaosExperiment, RecoveryAttempt } from "@streamshield/shared";
import { useAuth } from "../platform/auth-context";
import type { HealthTone } from "../proof/health";

export interface TimelineSegment {
  tone: HealthTone;
  from: string;
  to: string;
  durationMs: number;
  code: string | null;
  attemptId?: string;
}
export interface TimelineEvent {
  kind:
    "injected" | "detected" | "action" | "verified" | "escalated" | "failed";
  at: string;
  component: string;
  label: string;
  experimentId?: string;
}
export interface TimelineData {
  from: string;
  to: string;
  components: { id: string; segments: TimelineSegment[] }[];
  overall: TimelineSegment[];
  events: TimelineEvent[];
  truncated: boolean;
  experiments: ChaosExperiment[];
  attempts: RecoveryAttempt[];
  browserEvidence: {
    experimentId: string;
    at: string;
    metrics: Record<string, number | string>;
  }[];
}
export interface ImpactData {
  available: boolean;
  step: number;
  series: {
    id: string;
    label: string;
    unit: string;
    points: [number, number][];
  }[];
}
const window = (from: number, to: number) =>
  "?from=" +
  encodeURIComponent(new Date(from).toISOString()) +
  "&to=" +
  encodeURIComponent(new Date(to).toISOString());
/** Rolling window ending now; refreshes with monitoring invalidations too. */
export function useTimeline(spanMs: number, refetchMs = 5000) {
  const { call } = useAuth();
  return useQuery({
    queryKey: ["monitoring", "timeline", spanMs],
    queryFn: () => {
      const to = Date.now();
      return call<TimelineData>(
        "/monitoring/timeline" + window(to - spanMs, to),
      );
    },
    refetchInterval: refetchMs,
    retry: false,
  });
}
export function useTimelineRange(from: number, to: number, enabled = true) {
  const { call } = useAuth();
  return useQuery({
    queryKey: ["monitoring", "timeline-range", from, to],
    queryFn: () =>
      call<TimelineData>("/monitoring/timeline" + window(from, to)),
    enabled,
    retry: false,
  });
}
export function useImpact(from: number, to: number, refetchMs: number | false) {
  const { call } = useAuth();
  return useQuery({
    queryKey: ["monitoring", "impact", from, to],
    queryFn: () => call<ImpactData>("/monitoring/impact" + window(from, to)),
    refetchInterval: refetchMs,
    retry: false,
  });
}
/** Average of points inside [from, to] (seconds), or null when unmeasured. */
export function windowAverage(
  points: [number, number][],
  from: number,
  to: number,
) {
  const inside = points.filter(([at]) => at * 1000 >= from && at * 1000 <= to);
  return inside.length
    ? inside.reduce((n, [, v]) => n + v, 0) / inside.length
    : null;
}
