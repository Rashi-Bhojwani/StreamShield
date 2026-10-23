import type { ChaosExperiment, RecoveryAttempt } from "@streamshield/shared";

/** The shared health vocabulary (same as the web colour tokens). */
export type Tone =
  | "healthy"
  | "degraded"
  | "failed"
  | "healing"
  | "recovered"
  | "escalated"
  | "unknown";
export interface Segment {
  tone: Tone;
  from: string;
  to: string;
  durationMs: number;
  code: string | null;
  attemptId?: string;
  experimentId?: string;
}
export interface TimelineEvent {
  kind:
    "injected" | "detected" | "action" | "verified" | "escalated" | "failed";
  at: string;
  component: string;
  label: string;
  experimentId?: string;
  attemptId?: string;
}
export interface StateChange {
  component: string;
  state: string;
  code: string;
  at: string;
}
export interface Timeline {
  from: string;
  to: string;
  components: { id: string; segments: Segment[] }[];
  overall: Segment[];
  events: TimelineEvent[];
}
const RECOVERED_MS = 30000;
const DEPENDENCY_REASONS = [
  "authority_or_dependency_symptom",
  "component_returned_without_healer_action",
];
const toneOf = (state: string): Tone =>
  state === "HEALTHY"
    ? "healthy"
    : state === "UNHEALTHY"
      ? "failed"
      : state === "DEGRADED" || state === "RECOVERING"
        ? "degraded"
        : "unknown";
const t = (s: string) => Date.parse(s);
const iso = (n: number) => new Date(n).toISOString();
interface Span {
  tone: Tone;
  from: number;
  to: number;
  code: string | null;
  attemptId?: string;
  experimentId?: string;
}
/** Paint `over` on top of `base` spans (later paint wins), keeping boundaries exact. */
function paint(base: Span[], over: Span): Span[] {
  const out: Span[] = [];
  for (const s of base) {
    if (s.to <= over.from || s.from >= over.to) {
      out.push(s);
      continue;
    }
    if (s.from < over.from) out.push({ ...s, to: over.from });
    if (s.to > over.to) out.push({ ...s, from: over.to });
  }
  out.push(over);
  return out.sort((a, b) => a.from - b.from);
}
function merge(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const s of spans) {
    if (s.to <= s.from) continue;
    const last = out.at(-1);
    if (
      last &&
      last.tone === s.tone &&
      last.to === s.from &&
      last.attemptId === s.attemptId &&
      (last.code === s.code || s.tone === "healthy")
    )
      last.to = s.to;
    else out.push({ ...s });
  }
  return out;
}
const segment = (s: Span): Segment => ({
  tone: s.tone,
  from: iso(s.from),
  to: iso(s.to),
  durationMs: s.to - s.from,
  code: s.code,
  ...(s.attemptId ? { attemptId: s.attemptId } : {}),
  ...(s.experimentId ? { experimentId: s.experimentId } : {}),
});
const critical = [
  "postgres",
  "redis",
  "relay",
  "web",
  "api-gateway",
  "video-gateway",
];
const pairs = [
  ["api-1", "api-2"],
  ["edge-1", "edge-2"],
  ["origin-primary", "origin-standby"],
];
/** One overall tone per instant, with redundancy: one failed peer = on backup. */
export function overallTone(tones: Record<string, Tone>): Tone {
  const values = Object.values(tones);
  if (!values.length || values.every((v) => v === "unknown")) return "unknown";
  const failed = (id: string) => tones[id] === "failed";
  if (critical.some(failed) || pairs.some((p) => p.every(failed)))
    return "failed";
  if (values.includes("escalated")) return "escalated";
  if (values.includes("healing")) return "healing";
  if (values.includes("failed") || values.includes("degraded"))
    return "degraded";
  if (values.includes("unknown")) return "unknown";
  if (values.includes("recovered")) return "recovered";
  return "healthy";
}
/**
 * Builds segments only from persisted evidence: observer state transitions,
 * Healer attempts and chaos experiments. Time with no evidence is "unknown";
 * nothing is interpolated.
 */
export function buildTimeline(input: {
  from: string;
  to: string;
  /** Ordered by time; may include the last change before `from` per component. */
  changes: StateChange[];
  attempts: RecoveryAttempt[];
  experiments: ChaosExperiment[];
}): Timeline {
  const from = t(input.from),
    to = t(input.to);
  const ids = [...new Set(input.changes.map((c) => c.component))].sort();
  const components = ids.map((id) => {
    const own = input.changes
      .filter((c) => c.component === id)
      .sort((a, b) => t(a.at) - t(b.at));
    let spans: Span[] = [];
    const first = own[0] ? Math.max(from, t(own[0].at)) : to;
    if (first > from)
      spans.push({ tone: "unknown", from, to: first, code: "no_data" });
    own.forEach((c, i) => {
      const start = Math.max(from, t(c.at));
      const end = Math.min(to, own[i + 1] ? t(own[i + 1]!.at) : to);
      if (end > start)
        spans.push({
          tone: toneOf(c.state),
          from: start,
          to: end,
          code: c.code,
        });
    });
    for (const a of input.attempts.filter((a) => a.component === id)) {
      const healedFrom = a.actionStartedAt ? t(a.actionStartedAt) : null;
      const finished = a.finishedAt ? t(a.finishedAt) : to;
      if (healedFrom !== null)
        spans = paint(spans, {
          tone: "healing",
          from: Math.max(from, healedFrom),
          to: Math.min(to, finished),
          code: a.playbook,
          attemptId: a.id,
        });
      if (a.state === "VERIFIED" && a.finishedAt && a.actionStartedAt)
        spans = paint(spans, {
          tone: "recovered",
          from: Math.max(from, finished),
          to: Math.min(to, finished + RECOVERED_MS),
          code: a.playbook,
          attemptId: a.id,
        });
      // Dependency symptoms self-verify when the dependency returns; they are
      // shown by the observed state (degraded), not as a human escalation.
      if (
        a.state === "ESCALATED" &&
        a.finishedAt &&
        !DEPENDENCY_REASONS.includes(a.reason)
      ) {
        // Escalated until the next observed HEALTHY transition (or window end).
        const healthy = own.find(
          (c) => c.state === "HEALTHY" && t(c.at) > finished,
        );
        spans = paint(spans, {
          tone: "escalated",
          from: Math.max(from, finished),
          to: Math.min(to, healthy ? t(healthy.at) : to),
          code: a.reason,
          attemptId: a.id,
        });
      }
    }
    return { id, spans: merge(spans.filter((s) => s.to > s.from)) };
  });
  // Overall band: evaluate every interval between all component boundaries.
  const cuts = [
    ...new Set([
      from,
      to,
      ...components.flatMap((c) => c.spans.flatMap((s) => [s.from, s.to])),
    ]),
  ]
    .filter((n) => n >= from && n <= to)
    .sort((a, b) => a - b);
  const overall: Span[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i]!,
      b = cuts[i + 1]!;
    const tones: Record<string, Tone> = {};
    for (const c of components) {
      const s = c.spans.find((x) => x.from <= a && x.to > a);
      tones[c.id] = s ? s.tone : "unknown";
    }
    overall.push({ tone: overallTone(tones), from: a, to: b, code: null });
  }
  const events: TimelineEvent[] = [];
  const within = (at: string | null | undefined) =>
    !!at && t(at) >= from && t(at) <= to;
  for (const e of input.experiments) {
    const label = e.scenario;
    if (within(e.injectedAt))
      events.push({
        kind: "injected",
        at: e.injectedAt!,
        component: e.target,
        label: "Fault injected: " + label,
        experimentId: e.id,
      });
    if (within(e.incidentDetectedAt))
      events.push({
        kind: "detected",
        at: e.incidentDetectedAt!,
        component: e.target,
        label: "Detected: " + label,
        experimentId: e.id,
      });
    if (within(e.actionStartedAt))
      events.push({
        kind: "action",
        at: e.actionStartedAt!,
        component: e.target,
        label: "Healer acted: " + label,
        experimentId: e.id,
      });
    if (within(e.verifiedAt))
      events.push({
        kind: "verified",
        at: e.verifiedAt!,
        component: e.target,
        label: "Verified: " + label,
        experimentId: e.id,
      });
    if (["FAILED", "TIMED_OUT"].includes(e.state) && within(e.finishedAt))
      events.push({
        kind: "failed",
        at: e.finishedAt!,
        component: e.target,
        label: e.state + ": " + label,
        experimentId: e.id,
      });
  }
  for (const a of input.attempts)
    if (
      a.state === "ESCALATED" &&
      within(a.finishedAt) &&
      !DEPENDENCY_REASONS.includes(a.reason)
    )
      events.push({
        kind: "escalated",
        at: a.finishedAt!,
        component: a.component,
        label: "Escalated: " + a.reason,
        attemptId: a.id,
      });
  events.sort((a, b) => t(a.at) - t(b.at));
  return {
    from: iso(from),
    to: iso(to),
    components: components.map((c) => ({
      id: c.id,
      segments: c.spans.map(segment),
    })),
    overall: merge(overall).map(segment),
    events,
  };
}
/** Availability = healthy-ish time / time with evidence (unknown excluded). */
export function availability(segments: Segment[]) {
  let up = 0,
    known = 0;
  for (const s of segments) {
    if (s.tone === "unknown") continue;
    known += s.durationMs;
    if (["healthy", "recovered"].includes(s.tone)) up += s.durationMs;
  }
  return known ? up / known : null;
}
