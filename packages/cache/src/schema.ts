import { customType, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const blob = customType<{ data: Uint8Array | null; driverData: Uint8Array | null }>({
  dataType() {
    return "blob";
  },
});

export const chatCache = sqliteTable("chat_cache", {
  id: text("id").primaryKey(), // SHA-256 of concatenated messages + parameters
  userId: text("user_id"),
  threadId: text("thread_id"),
  providerId: text("provider_id").notNull(),
  model: text("model").notNull(),
  promptText: text("prompt_text").notNull(),
  responseText: text("response_text").notNull(),
  embedding: blob("embedding"),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at"),
});

export const chatCacheVectorsMeta = sqliteTable("chat_cache_vectors_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// Maps the string cache id (SHA-256) to a stable integer rowid usable by the
// sqlite-vec vec0 virtual table (whose rowid MUST be an integer). Using an
// autoincrement integer here avoids both (a) calling an unregistered SQL
// function in the vec0 search join and (b) 32-bit hash collisions between
// distinct cache ids.
export const chatCacheVectorMap = sqliteTable("chat_cache_vector_map", {
  rowid: integer("rowid").primaryKey({ autoIncrement: true }),
  cacheId: text("cache_id").notNull().unique(),
});
