export const up = (pgm) =>
  pgm.sql(`
CREATE TABLE chaos_experiments(id uuid PRIMARY KEY,actor uuid NOT NULL,scenario text NOT NULL,state text NOT NULL,body jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX chaos_history ON chaos_experiments(created_at DESC,id);
`);
export const down = () => {
  throw Error(
    "Chaos audit rollback requires explicit evidence retention review.",
  );
};
