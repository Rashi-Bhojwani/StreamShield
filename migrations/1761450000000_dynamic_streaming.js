export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users ADD COLUMN avatar_color text NOT NULL DEFAULT '#52d7c7' CHECK (avatar_color ~ '^#[0-9a-fA-F]{6}$');
    ALTER TABLE streams ADD COLUMN category text NOT NULL DEFAULT 'Other';
    ALTER TABLE streams ADD COLUMN dynamic_session boolean NOT NULL DEFAULT false;
    CREATE UNIQUE INDEX streams_one_dynamic_publisher ON streams(channel_id) WHERE dynamic_session AND lifecycle='ready';
    ALTER TABLE streams ADD COLUMN broadcast_state text NOT NULL DEFAULT 'CREATED'
      CHECK (broadcast_state IN ('CREATED','PREPARING','PUBLISHING','LIVE','CONNECTION_LOST','RECONNECTING','ENDING','ENDED','FAILED'));
    ALTER TABLE streams ADD COLUMN media_bytes bigint NOT NULL DEFAULT 0;
    ALTER TABLE streams ADD COLUMN media_progress_at timestamptz;
    ALTER TABLE streams ADD COLUMN source_lost_at timestamptz;
    ALTER TABLE streams ADD COLUMN dynamic_checked_at timestamptz;
    ALTER TABLE streams ADD COLUMN state_changed_at timestamptz NOT NULL DEFAULT now();
    CREATE INDEX streams_live_discovery ON streams(broadcast_state,created_at DESC,id) WHERE lifecycle='ready';
    CREATE INDEX streams_dynamic_scan ON streams(dynamic_checked_at) WHERE lifecycle='ready';
    CREATE TABLE broadcast_events (
      id bigserial PRIMARY KEY, stream_id uuid NOT NULL REFERENCES streams(id),
      state text NOT NULL, reason text NOT NULL, observed_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX broadcast_events_stream ON broadcast_events(stream_id,id DESC);
    CREATE TABLE chat_bans (
      channel_id uuid NOT NULL REFERENCES channels(id), user_id uuid NOT NULL REFERENCES users(id),
      actor_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(channel_id,user_id)
    );
  `);
};
export const down = () => {
  throw new Error(
    "Dynamic broadcast history must not be deleted by an automatic rollback.",
  );
};
