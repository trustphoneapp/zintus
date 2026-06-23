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

-- Stripe billing subscriptions
CREATE TABLE IF NOT EXISTS subscriptions (
  id                      TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id                 TEXT NOT NULL REFERENCES zintus_users(id) ON DELETE CASCADE,
  tier                    TEXT NOT NULL DEFAULT 'free',
  stripe_customer_id      TEXT,
  stripe_subscription_id  TEXT UNIQUE,
  status                  TEXT NOT NULL DEFAULT 'active',
  current_period_start    INTEGER,
  current_period_end      INTEGER,
  tokens_used_this_period INTEGER DEFAULT 0,
  tokens_limit            INTEGER,
  created_at              INTEGER DEFAULT (unixepoch()),
  updated_at              INTEGER DEFAULT (unixepoch())
);

-- Per-request usage log for analytics
CREATE TABLE IF NOT EXISTS usage_log (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id       TEXT NOT NULL REFERENCES zintus_users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER DEFAULT (unixepoch())
);

-- Referral program tracking
CREATE TABLE IF NOT EXISTS referrals (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  referrer_id      TEXT NOT NULL REFERENCES zintus_users(id) ON DELETE CASCADE,
  referred_id      TEXT NOT NULL REFERENCES zintus_users(id) ON DELETE CASCADE,
  referral_code    TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  commission_tier  TEXT NOT NULL,
  commission_type  TEXT NOT NULL DEFAULT 'one_time',
  commission_pct   REAL NOT NULL DEFAULT 0,
  commission_cents INTEGER NOT NULL DEFAULT 0,
  months_remaining INTEGER NOT NULL DEFAULT 0,
  stripe_coupon_id TEXT,
  activated_at     INTEGER,
  expires_at       INTEGER,
  created_at       INTEGER DEFAULT (unixepoch()),
  UNIQUE(referrer_id, referred_id)
);

-- Per-user referral codes (one per user, stable)
CREATE TABLE IF NOT EXISTS referral_codes (
  code    TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES zintus_users(id) ON DELETE CASCADE,
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(user_id)
);
