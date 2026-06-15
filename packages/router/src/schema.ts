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
  timestamp: integer("timestamp").notNull(),
  requests: integer("requests").notNull().default(1),
  tokensIn: integer("tokens_in").notNull().default(0),
  tokensOut: integer("tokens_out").notNull().default(0),
  status: text("status").notNull(),
  errorCode: integer("error_code"),
});
