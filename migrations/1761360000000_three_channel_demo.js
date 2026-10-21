export const up = (pgm) =>
  pgm.sql(`
CREATE TABLE demo_channels (
 slot smallint PRIMARY KEY CHECK(slot BETWEEN 1 AND 3),
 user_id uuid NOT NULL UNIQUE REFERENCES users(id),
 channel_id uuid NOT NULL UNIQUE REFERENCES channels(id),
 stream_id uuid NOT NULL UNIQUE REFERENCES streams(id),
 last_status text NOT NULL DEFAULT 'unknown'
);
CREATE TABLE demo_guests (
 id uuid PRIMARY KEY, token_hash text NOT NULL UNIQUE, name text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE INDEX demo_guests_expiry ON demo_guests(expires_at);
ALTER TABLE chat_messages ALTER COLUMN sender_id DROP NOT NULL;
ALTER TABLE chat_messages ADD COLUMN guest_id uuid REFERENCES demo_guests(id);
ALTER TABLE chat_messages ADD CONSTRAINT chat_sender CHECK ((sender_id IS NULL) <> (guest_id IS NULL));
CREATE TABLE demo_local_tickets (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id),
 expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE TABLE demo_broadcast_history (
 id bigserial PRIMARY KEY, stream_id uuid NOT NULL REFERENCES streams(id),
 status text NOT NULL, observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX demo_history_stream ON demo_broadcast_history(stream_id,id DESC);
CREATE TABLE capacity_runs (
 id uuid PRIMARY KEY, token_hash text NOT NULL UNIQUE,
 profile text NOT NULL CHECK(profile IN ('api','socket','chat','hls','browser')),
 target_origin text NOT NULL, target_clients integer NOT NULL CHECK(target_clients BETWEEN 1 AND 50000),
 distributed boolean NOT NULL, duration_seconds integer NOT NULL CHECK(duration_seconds BETWEEN 5 AND 900),
 ramp_seconds integer NOT NULL CHECK(ramp_seconds BETWEEN 1 AND 300),
 chat_per_second integer NOT NULL CHECK(chat_per_second BETWEEN 0 AND 100),
 state text NOT NULL DEFAULT 'CREATED' CHECK(state IN ('CREATED','RUNNING','COMPLETED','STOPPED','EXPIRED')),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 stopped_at timestamptz
);
CREATE TABLE capacity_workers (
 id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES capacity_runs(id),
 clients integer NOT NULL CHECK(clients BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 report_seq integer NOT NULL DEFAULT 0, report jsonb,
 finished boolean NOT NULL DEFAULT false
);
CREATE INDEX capacity_workers_run ON capacity_workers(run_id);
CREATE TABLE capacity_samples (
 run_id uuid NOT NULL REFERENCES capacity_runs(id), second bigint NOT NULL,
 sample jsonb NOT NULL, PRIMARY KEY(run_id,second)
);
`);
// Additive migration: rollback must never delete existing user/chat/stream data.
export const down = () => {
  throw Error(
    "Restore a verified backup for schema rollback; destructive down is intentionally unavailable.",
  );
};
