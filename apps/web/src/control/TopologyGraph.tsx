import type {
  ComponentObservation,
  RecoveryAttempt,
} from "@streamshield/shared";
import { tones, type HealthTone } from "../proof/health";
import { componentTone } from "./evidence";

type Node = {
  id: string;
  label: string;
  x: number;
  y: number;
  /** Not an observed component: drawn grey with a neutral label. */
  virtual?: boolean;
  optional?: boolean;
};
const W = 150,
  H = 46;
const nodes: Node[] = [
  { id: "web", label: "Web", x: 20, y: 40 },
  { id: "api-gateway", label: "API Gateway", x: 200, y: 40 },
  { id: "api-1", label: "API-1", x: 380, y: 10 },
  { id: "api-2", label: "API-2", x: 380, y: 70 },
  { id: "api-3", label: "API-3 (spare)", x: 380, y: 130, optional: true },
  { id: "postgres", label: "PostgreSQL", x: 560, y: 10 },
  { id: "redis", label: "Redis", x: 560, y: 70 },
  { id: "observer", label: "Observer", x: 740, y: 10, virtual: true },
  { id: "healer", label: "Healer", x: 740, y: 70, virtual: true },
  { id: "source", label: "Browser / OBS", x: 20, y: 300, virtual: true },
  { id: "relay", label: "Ingest Relay", x: 200, y: 300 },
  { id: "origin-primary", label: "Primary Origin", x: 380, y: 260 },
  { id: "origin-standby", label: "Standby Origin", x: 380, y: 340 },
  { id: "edge-1", label: "Edge-1", x: 560, y: 260 },
  { id: "edge-2", label: "Edge-2", x: 560, y: 340 },
  { id: "video-gateway", label: "Video Gateway", x: 740, y: 300 },
];
const edges: [string, string][] = [
  ["web", "api-gateway"],
  ["api-gateway", "api-1"],
  ["api-gateway", "api-2"],
  ["api-gateway", "api-3"],
  ["api-1", "postgres"],
  ["api-1", "redis"],
  ["api-2", "postgres"],
  ["api-2", "redis"],
  ["api-3", "postgres"],
  ["api-3", "redis"],
  ["source", "relay"],
  ["relay", "origin-primary"],
  ["relay", "origin-standby"],
  ["origin-primary", "edge-1"],
  ["origin-primary", "edge-2"],
  ["origin-standby", "edge-1"],
  ["origin-standby", "edge-2"],
  ["edge-1", "video-gateway"],
  ["edge-2", "video-gateway"],
];
const find = (id: string) => nodes.find((n) => n.id === id)!;
export function TopologyGraph({
  components,
  attempts,
  stale,
  overlay = {},
  healerAvailable,
}: {
  components: ComponentObservation[];
  attempts: RecoveryAttempt[];
  stale: boolean;
  overlay?: Record<string, string>;
  healerAvailable?: boolean;
}) {
  const tone = (n: Node): HealthTone => {
    if (n.id === "observer") return stale ? "unknown" : "healthy";
    if (n.id === "healer")
      return stale || healerAvailable === undefined
        ? "unknown"
        : healerAvailable
          ? "healthy"
          : "failed";
    if (n.virtual) return "unknown";
    return componentTone(
      components.find((c) => c.id === n.id),
      attempts,
      stale,
    );
  };
  const visible = nodes.filter(
    (n) => !n.optional || components.some((c) => c.id === n.id),
  );
  const has = (id: string) => visible.some((n) => n.id === id);
  return (
    <figure className="topology-graph" aria-label="Live topology">
      <svg viewBox="0 0 910 400" role="img" aria-labelledby="topology-title">
        <title id="topology-title">
          StreamShield live topology: application path on top, media path below;
          colours come from observed state.
        </title>
        <text x="20" y="245" className="topo-lane">
          MEDIA PATH
        </text>
        <text x="20" y="-0" className="topo-lane" dy="12">
          APPLICATION PATH
        </text>
        {edges
          .filter(([a, b]) => has(a) && has(b))
          .map(([a, b]) => {
            const p = find(a),
              q = find(b);
            return (
              <line
                key={a + b}
                x1={p.x + W}
                y1={p.y + H / 2}
                x2={q.x}
                y2={q.y + H / 2}
                className="topo-link"
              />
            );
          })}
        {/* Video gateway delivers back to the web origin the browser plays from. */}
        <path
          d={`M${740 + W} ${300 + H / 2} C 905 ${300 + H / 2}, 905 200, 470 200 S 95 200, 95 ${40 + H}`}
          className="topo-link topo-return"
        />
        <text x="470" y="194" className="topo-note" textAnchor="middle">
          HLS to viewers via Web
        </text>
        <text x="815" y="134" className="topo-note" textAnchor="middle">
          watch every component
        </text>
        {visible.map((n) => {
          const t = tone(n);
          return (
            <g
              key={n.id}
              transform={`translate(${n.x} ${n.y})`}
              className={"topo-node tone-" + t + (n.virtual ? " virtual" : "")}
              data-node={n.id}
              data-tone={t}
            >
              <rect width={W} height={H} rx="10" />
              <text x="12" y="19" className="topo-name">
                {tones[t].icon} {n.label}
              </text>
              <text x="12" y="36" className="topo-state">
                {overlay[n.id] ||
                  (n.virtual && !["observer", "healer"].includes(n.id)
                    ? "broadcaster client"
                    : tones[t].label)}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="topology-legend">
        {(
          [
            "healthy",
            "degraded",
            "failed",
            "healing",
            "recovered",
            "escalated",
            "unknown",
          ] as HealthTone[]
        ).map((t) => (
          <span key={t} className={"legend-item tone-" + t}>
            <i aria-hidden="true">{tones[t].icon}</i>
            {tones[t].label}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
