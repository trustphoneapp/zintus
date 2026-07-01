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
  // Nullable: global- and project-scoped facts have no owning thread.
  threadId: text("thread_id"),
  key: text("key").notNull(),
  value: text("value").notNull(),
  source: text("source"),
  // Governance (2026): where the fact applies + provenance + curation.
  scope: text("scope").notNull().default("thread"),
  projectId: text("project_id"),
  pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
  /** Epoch ms the fact was last INCLUDED in a compiled context (curation/eviction). */
  lastUsedAt: integer("last_used_at"),
  /** Id of the message this fact was extracted from (provenance). */
  sourceMessageId: text("source_message_id"),
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
