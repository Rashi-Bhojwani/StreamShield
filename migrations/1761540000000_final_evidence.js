export const up = (pgm) =>
  pgm.sql(`
-- Append-only observer state history: one row per thresholded state transition.
CREATE TABLE monitoring_state_changes(
  id bigserial PRIMARY KEY,
  component text NOT NULL CHECK (component ~ '^[a-z0-9-]{1,40}$'),
  state text NOT NULL CHECK (state IN ('HEALTHY','DEGRADED','UNHEALTHY','UNKNOWN','RECOVERING')),
  previous text,
  code text NOT NULL,
  at timestamptz NOT NULL
);
CREATE INDEX monitoring_state_changes_at ON monitoring_state_changes(at, component);
-- Browser-observed evidence attached by the administrator who ran the experiment.
CREATE TABLE chaos_browser_evidence(
  id bigserial PRIMARY KEY,
  experiment_id uuid NOT NULL REFERENCES chaos_experiments(id),
  actor uuid NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  metrics jsonb NOT NULL CHECK (jsonb_typeof(metrics) = 'object')
);
CREATE INDEX chaos_browser_evidence_experiment ON chaos_browser_evidence(experiment_id, id);
`);
export const down = () => {
  throw Error("Evidence rollback requires explicit retention review.");
};
