export const up = (pgm) =>
  pgm.sql(`
CREATE TABLE monitoring_state (
 id text PRIMARY KEY CHECK (id='observer'), sequence bigint NOT NULL DEFAULT 0,
 observed_at timestamptz NOT NULL, snapshot jsonb NOT NULL
);
CREATE TABLE monitoring_components (id text PRIMARY KEY, observation jsonb NOT NULL);
CREATE TABLE monitoring_incidents (
 id uuid PRIMARY KEY, component text NOT NULL, failure_identity text NOT NULL DEFAULT 'availability',
 severity text NOT NULL CHECK(severity IN ('warning','critical')),
 state text NOT NULL CHECK(state IN ('DETECTED','DIAGNOSED','SERVICE_RESTORED','RECOVERY_VERIFIED','RESOLVED')),
 source text NOT NULL DEFAULT 'observer-probe-v1', correlation_id uuid NOT NULL,
 first_observed_at timestamptz NOT NULL, detected_at timestamptz NOT NULL,
 restored_at timestamptz, verified_at timestamptz, resolved_at timestamptz,
 detection_ms double precision, duration_ms double precision,
 evidence jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX monitoring_one_active ON monitoring_incidents(component,failure_identity) WHERE resolved_at IS NULL;
CREATE INDEX monitoring_incident_history ON monitoring_incidents(detected_at DESC,id);
CREATE TABLE monitoring_incident_events (
 seq bigserial PRIMARY KEY, incident_id uuid NOT NULL REFERENCES monitoring_incidents(id) ON DELETE CASCADE,
 state text NOT NULL, at timestamptz NOT NULL, evidence jsonb NOT NULL
);
CREATE INDEX monitoring_event_lookup ON monitoring_incident_events(incident_id,seq);
`);
export const down = () => {
  throw new Error("Observability evidence rollback is intentionally disabled.");
};
