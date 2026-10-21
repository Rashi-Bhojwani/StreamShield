import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
const output = "test-results/capacity";
mkdirSync(output, { recursive: true });
const results = readdirSync(".local/demo")
  .filter((name) => /^result-[a-f0-9-]+\.json$/.test(name))
  .map((name) => JSON.parse(readFileSync(".local/demo/" + name, "utf8")));
if (!results.length)
  throw Error(
    "No actual generator results; configuration alone is not capacity evidence",
  );
for (const r of results) {
  if (!r.finalReportConfirmed || r.measurements.stopReason !== "deadline")
    throw Error("Capacity measurement did not finish with a confirmed audit");
}
const summary = {
  status: "MEASURED",
  capacity50000Status: "PARTIAL_UNVERIFIED",
  measuredAt: new Date().toISOString(),
  results,
  definition:
    "Independent socket connection measurements; requested allocation is not achieved capacity or decoded video. A stage may finish below target with actual connection failures recorded.",
};
writeFileSync(output + "/measurements.json", JSON.stringify(summary, null, 2));
for (const r of results)
  console.log(
    JSON.stringify({
      profile: r.profile,
      target: r.targetClients,
      actualConnectedPeak: r.measurements.peak,
      connectFailures: r.measurements.connectionFailures,
      reconnects: r.measurements.reconnects,
      finalReportConfirmed: r.finalReportConfirmed,
    }),
  );
