import { readFileSync } from "node:fs";
export const up = (pgm) =>
  pgm.sql(readFileSync(new URL("./platform.sql", import.meta.url), "utf8"));
export const down = () => {
  throw new Error(
    "Destructive rollback disabled; use a reviewed forward migration.",
  );
};
