-- D1 schema for Zintus relay service.
-- Better Auth manages its own tables (ba_users, ba_sessions, etc.) via migrations.
-- These are the Zintus-specific gateway session tables.

CREATE TABLE IF NOT EXISTS zintus_users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL
);

-- A gateway session ties a home machine to a user account.
-- gateway_secret is stored only as a SHA-256 hash — never in plaintext.
CREATE TABLE IF NOT EXISTS gateway_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES zintus_users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'My Gateway',
  gateway_secret_hash TEXT NOT NULL,
  last_seen INTEGER,
  online INTEGER NOT NULL DEFAULT 0
);

-- Tracks magic-link and OAuth state (short-lived, also cached in KV).
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT,
  token_type TEXT NOT NULL, -- 'magic_link' | 'cli_state' | 'mobile_otp'
  payload TEXT,             -- JSON: { session_id, gateway_secret } for cli_state
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

-- User sessions (long-lived; also indexed in KV for fast lookup).
CREATE TABLE IF NOT EXISTS user_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES zintus_users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
