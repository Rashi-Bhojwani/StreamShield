CREATE TABLE users (
 id uuid PRIMARY KEY, username text NOT NULL UNIQUE, email text NOT NULL UNIQUE,
 password_hash text NOT NULL, role text NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer','broadcaster','administrator')),
 display_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (username = lower(username)), CHECK (email = lower(email))
);
CREATE TABLE auth_sessions (
 token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE INDEX sessions_user ON auth_sessions(user_id);
CREATE INDEX sessions_expiry ON auth_sessions(expires_at);
CREATE TABLE channels (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
 slug text NOT NULL UNIQUE, display_name text NOT NULL, description text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (slug ~ '^[a-z0-9][a-z0-9_-]{2,39}$')
);
CREATE TABLE streams (
 id uuid PRIMARY KEY, channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
 title text NOT NULL, description text NOT NULL DEFAULT '', media_path text NOT NULL UNIQUE,
 publish_hash text, lifecycle text NOT NULL DEFAULT 'draft' CHECK (lifecycle IN ('draft','ready','ended')),
 started_at timestamptz, ended_at timestamptz, last_live_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK (media_path ~ '^s-[a-f0-9]{32}$')
);
CREATE INDEX streams_channel_created ON streams(channel_id, created_at DESC, id);
CREATE TABLE chat_messages (
 seq bigserial PRIMARY KEY, id uuid NOT NULL UNIQUE,
 stream_id uuid NOT NULL REFERENCES streams(id) ON DELETE RESTRICT,
 sender_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 1000),
 deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_stream_order ON chat_messages(stream_id,seq DESC);
