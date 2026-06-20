import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const providers = sqliteTable("providers", {
  id: text("id").primaryKey(),
  requestsToday: integer("requests_today").notNull().default(0),
  tokensToday: integer("tokens_today").notNull().default(0),
  lastReset: integer("last_reset"),
  cooldownUntil: integer("cooldown_until"),
});

export const usageLog = sqliteTable("usage_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  providerId: text("provider_id").notNull(),
  model: text("model"),
  timestamp: integer("timestamp").notNull(),
  requests: integer("requests").notNull().default(1),
  tokensIn: integer("tokens_in").notNull().default(0),
  tokensOut: integer("tokens_out").notNull().default(0),
  status: text("status").notNull(),
  errorCode: integer("error_code"),
  latencyMs: integer("latency_ms"),
});

export const virtualKeys = sqliteTable("virtual_keys", {
  id: text("id").primaryKey(),
  name: text("name"),
  requestsToday: integer("requests_today").notNull().default(0),
  tokensToday: integer("tokens_today").notNull().default(0),
  lastReset: integer("last_reset"),
  requestsLimit: integer("requests_limit"),
  tokensLimit: integer("tokens_limit"),
  requestsPerMinute: integer("requests_per_minute"),
  tokensPerMinute: integer("tokens_per_minute"),
});

// Timestamped per-virtual-key usage events, for rolling 60s RPM/TPM windows.
export const vkUsage = sqliteTable("vk_usage", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  vkId: text("vk_id").notNull(),
  timestamp: integer("timestamp").notNull(),
  tokens: integer("tokens").notNull().default(0),
});
