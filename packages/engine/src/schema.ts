import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const threads = sqliteTable("threads", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  providerId: text("provider_id"),
  model: text("model"),
  traceId: text("trace_id"),
  createdAt: integer("created_at").notNull(),
});

export const traces = sqliteTable("traces", {
  id: text("id").primaryKey(),
  startedAt: integer("started_at").notNull(),
  completedAt: integer("completed_at"),
  winnerProviderId: text("winner_provider_id"),
  winnerModel: text("winner_model"),
  totalLatencyMs: integer("total_latency_ms"),
});

export const traceAttempts = sqliteTable("trace_attempts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  traceId: text("trace_id").notNull(),
  providerId: text("provider_id").notNull(),
  model: text("model").notNull(),
  status: text("status").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  errorCode: integer("error_code"),
  errorMessage: text("error_message"),
});
