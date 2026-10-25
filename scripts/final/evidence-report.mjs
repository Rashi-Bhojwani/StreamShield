// Builds the per-run tables of docs/SELF_HEALING_RECOVERY_EVIDENCE.md from
// measurement JSON produced by test:final. Every duration is recomputed from the
// stored timestamps; nothing is typed in by hand.
// Usage: node scripts/final/evidence-report.mjs <measurements.json>... > tables.md
import { readFileSync } from "node:fs";

const files = process.argv.slice(2);
// Accepts single test:final outputs or the merged docs/FINAL_MEASUREMENTS.json.
const runs = files.flatMap((f) => {
  const d = JSON.parse(readFileSync(f, "utf8"));
  return (d.executions || [d]).flatMap((x) =>
    x.runs.map((r) => ({
      ...r,
      execution:
        (x.execution ? "#" + x.execution + " " : "") +
        x.generatedAt.slice(0, 16),
      machine: x.machine,
    })),
  );
});
const ms = (a, b) =>
  a && b && Number.isFinite(Date.parse(a)) && Number.isFinite(Date.parse(b))
    ? Date.parse(b) - Date.parse(a)
    : null;
const s = (v) => (v == null ? "—" : (v / 1000).toFixed(1) + " s");
const t = (v) => (v ? v.slice(11, 23) : "—");
const visible = (r) => {
  const v = r.visible || {};
  switch (r.scenario) {
    case "crash-redis":
      return `cross-instance chat during outage: ${v.crossInstanceChatDuringOutage ? "delivered" : "failed"}; viewer chat state: ${v.viewerChatStatusDuringOutage ?? "—"}; after repair: ${v.crossInstanceChatAfterRepair ? "delivered" : "not delivered"}; video frames decoded during experiment: ${v.framesDecodedDuringExperiment ?? "—"}`;
    case "crash-video-gateway":
      return `viewer requests failed while down: ${v.viewerRequestsFailedWhileDown ?? "—"}; longest decoded gap ${s(v.longestDecodedGapMs ?? v.longestStallMs)}; resumed without reload`;
    case "crash-relay":
      return `publisher reconnects: ${v.publisherReconnects ?? "—"}; longest stall ${s(v.longestStallMs)}; broadcaster reconnected by itself: ${r.evidence?.broadcasterClientReconnected}`;
    case "hang-api":
      return `max request latency ${s(v.maxRequestLatencyMs)} (${v.slowRequests ?? "—"} slow of ${v.requestsDuringWindow ?? "—"}); after: ${s(v.normalLatencyAfterMs)}`;
    case "crash-edge":
      return `edges serving after injection: ${(v.edgesServingAfterInjection || []).join(", ")}; Edge-1 back after ${s(v.onlyEdge2UntilMs)}`;
    case "crash-primary":
      return `viewer source switches: ${(v.sourceSwitches || []).map((x) => x.to).join(", ") || "none"}`;
    case "traffic-surge":
      return `users ${r.evidence?.loadUsers ?? r.evidence?.simulatedUsers}; load p95 ${s(r.evidence?.loadP95Ms)}; requests ${r.evidence?.loadRequests}; API-3 served real requests: ${v.api3ServedRealRequests}; scaled in: ${r.evidence?.scaledIn}`;
    case "crash-api-tier":
      return `outage banner shown: ${v.outageBannerShown} (after ${s(v.bannerAfterInjectionMs)}); video advanced while APIs down: ${v.videoAdvancedWhileApiDown}; banner cleared ${s(v.bannerClearedAfterVerificationMs)} after verification`;
    default:
      return "—";
  }
};
const out = [];
out.push(
  "| Execution | Round | Scenario | Outcome | Injected | Detected | Healer acted | Action | Verified | Detect | Act | Action time | Restore | Receipts | Visible impact |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
);
for (const r of runs) {
  const ts = r.timestamps;
  out.push(
    `| ${r.execution} | ${r.round} | ${r.scenario} | ${r.state} | ${t(ts.injected)} | ${t(ts.incidentDetected)} | ${t(ts.actionStarted)} | ${t(ts.actionFinished)} | ${t(ts.verified)} | ${s(ms(ts.injected, ts.incidentDetected))} | ${s(ms(ts.injected, ts.actionStarted))} | ${s(ms(ts.actionStarted, ts.actionFinished))} | ${s(ms(ts.injected, ts.verified))} | ${(r.attempts || []).map((a) => a.component + ":" + a.receipt).join(", ")} | ${visible(r)} |`,
  );
}
out.push("", "### Variability across runs (completed runs)", "");
out.push(
  "| Scenario | Runs | Detect min / median / max | Restore min / median / max |",
  "|---|---|---|---|",
);
const by = {};
for (const r of runs.filter((x) => x.state === "COMPLETED"))
  (by[r.scenario] ||= []).push(r);
const stat = (v) => {
  const x = v.filter((n) => n != null).sort((a, b) => a - b);
  return x.length
    ? `${s(x[0])} / ${s(x[Math.floor(x.length / 2)])} / ${s(x.at(-1))}`
    : "—";
};
for (const [k, list] of Object.entries(by))
  out.push(
    `| ${k} | ${list.length} | ${stat(list.map((r) => ms(r.timestamps.injected, r.timestamps.incidentDetected)))} | ${stat(list.map((r) => ms(r.timestamps.injected, r.timestamps.verified)))} |`,
  );
console.log(out.join("\n"));
