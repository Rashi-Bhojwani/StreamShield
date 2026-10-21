import { execFileSync } from "node:child_process";
const args = process.argv.slice(2),
  at = args.indexOf("--levels"),
  levels = at < 0 ? [100, 1000] : args[at + 1].split(",").map(Number);
if (
  !args.includes("--authorize-owned-target") ||
  levels.some((n) => !Number.isInteger(n) || n < 1 || n > 1000)
)
  throw Error(
    "Local stages require owned-target authorization and levels <=1000. Larger distributed stages use a separate finite grant and resource-checked workers.",
  );
const remaining =
  at < 0 ? args : args.filter((_, i) => i !== at && i !== at + 1);
for (const clients of levels) {
  console.log(
    `Starting independent bounded local stage: ${clients} requested clients`,
  );
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/capacity/run.mjs",
      ...remaining,
      "--clients",
      String(clients),
    ],
    { stdio: "inherit" },
  );
}
