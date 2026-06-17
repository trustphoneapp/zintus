import { customType, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const blob = customType<{ data: Uint8Array | null; driverData: Uint8Array | null }>({
  dataType() {
    return "blob";
  },
});

export const threadState = sqliteTable("thread_state", {
  threadId: text("thread_id").primaryKey(),
  stateJson: text("state_json").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const memoryFacts = sqliteTable("memory_facts", {
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull(),
  key: text("key").notNull(),
  value: text("value").notNull(),
  source: text("source"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const memoryChunks = sqliteTable("memory_chunks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  threadId: text("thread_id").notNull(),
  content: text("content").notNull(),
  embedding: blob("embedding"),
  metadataJson: text("metadata_json"),
  createdAt: integer("created_at").notNull(),
});

export const compileTraces = sqliteTable("compile_traces", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  threadId: text("thread_id").notNull(),
  traceJson: text("trace_json").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const threadCheckpoints = sqliteTable("thread_checkpoints", {
  threadId: text("thread_id").notNull(),
  checkpointId: text("checkpoint_id").notNull(),
  parentCheckpointId: text("parent_checkpoint_id"),
  stateBin: blob("state_bin").notNull(),
  createdAt: integer("created_at").notNull(),
});
