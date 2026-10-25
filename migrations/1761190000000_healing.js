export const up = (pgm) =>
  pgm.sql(`
CREATE TABLE healing_attempts (
 id uuid PRIMARY KEY, incident_id uuid REFERENCES monitoring_incidents(id) ON DELETE SET NULL,
 component text NOT NULL, episode text NOT NULL UNIQUE, playbook text NOT NULL,
 state text NOT NULL CHECK(state IN ('SCHEDULED','EXECUTING','VERIFYING','RETRY_WAIT','VERIFIED','ESCALATED')),
 epoch bigint NOT NULL, body jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX healing_history ON healing_attempts(updated_at DESC,id);
CREATE INDEX healing_incident ON healing_attempts(incident_id);
CREATE TABLE healing_events (
 attempt_id uuid NOT NULL REFERENCES healing_attempts(id) ON DELETE CASCADE,
 ordinal integer NOT NULL, state text NOT NULL, at timestamptz NOT NULL, reason text NOT NULL,
 PRIMARY KEY(attempt_id,ordinal)
);
CREATE TABLE healing_verification (id uuid PRIMARY KEY, checked_at timestamptz NOT NULL);
CREATE VIEW healing_expected_sources AS SELECT media_path FROM streams WHERE lifecycle='ready';
`);
export const down = () => {
  throw new Error(
    "Recovery audit rollback requires an explicit evidence retention review.",
  );
};
