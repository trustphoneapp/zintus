export interface Env {
  GATEWAY_SESSION: DurableObjectNamespace;
  /** Strongly-consistent per-user/period token-usage counter (see QuotaCounter.ts). */
  QUOTA_COUNTER: DurableObjectNamespace;
  /** Cross-isolate authority for encrypted GitHub credentials and refresh rotation. */
  GITHUB_CREDENTIALS: DurableObjectNamespace;
  DB: D1Database;
  KV: KVNamespace;
  RELAY_BASE_URL: string;
  COOKIE_DOMAIN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  RESEND_API_KEY: string;
  // Stripe
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  // Observability (opt-in; unset → no-op error sink, see observability.ts)
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  // Managed-membership operator provider keys (Cloudflare secrets, [HUMAN]-set;
  // see managed.ts). A model is only listed/servable when its key is present —
  // unset keys degrade honestly, they never 500.
  MANAGED_KEY_GROQ?: string;
  MANAGED_KEY_CEREBRAS?: string;
  MANAGED_KEY_OPENAI?: string;
  MANAGED_KEY_DEEPSEEK?: string;
  MANAGED_KEY_MOONSHOT?: string;
  /** Together AI — serves FLUX-schnell image generation (flat-fee service). */
  MANAGED_KEY_TOGETHER?: string;
  MANAGED_KEY_ANTHROPIC?: string;
  MANAGED_KEY_GEMINI?: string;
  MANAGED_KEY_ZAI?: string;
  MANAGED_KEY_MISTRAL?: string;
  MANAGED_KEY_XAI?: string;
  /** Tavily — external web-search fallback for managed chat (see managed.ts). */
  TAVILY_API_KEY?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_CALLBACK_URL?: string;
  GITHUB_APP_ID?: string;
  GITHUB_PRIVATE_KEY?: string;
  RELAY_ENCRYPTION_KEY?: string;
  WEB_BASE_URL?: string;
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

export interface SubscriptionRow {
  id: string;
  user_id: string;
  tier: 'free' | 'starter' | 'pro' | 'max';
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  status: 'active' | 'past_due' | 'cancelled';
  current_period_end: number | null;
  tokens_used_this_period: number;
  tokens_limit: number | null;
}

export interface ReferralCodeRow {
  code: string;
  user_id: string;
}
