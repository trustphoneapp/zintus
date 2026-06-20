export interface Env {
  GATEWAY_SESSION: DurableObjectNamespace;
  DB: D1Database;
  KV: KVNamespace;
  RELAY_AUTH_SECRET: string;
  RELAY_BASE_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  RESEND_API_KEY: string;
}

/** Attached to every accepted WebSocket (survives DO hibernation). */
export interface WsAttachment {
  session_id: string;
  user_id: string;
  last_seen: number;
  relay_token_hash: string | null;
}

export interface GatewaySessionRow {
  id: string;
  user_id: string;
  name: string;
  gateway_secret_hash: string;
  last_seen: number | null;
  online: 0 | 1;
}

export interface UserRow {
  id: string;
  email: string;
  created_at: number;
}

export interface UserSessionRow {
  id: string;
  user_id: string;
  created_at: number;
  expires_at: number;
}
