import * as SQLite from "expo-sqlite";
import type { ProviderId, RoutingStrategy } from "@zintus/types";

import type { ResponseMeta } from "@/lib/chat";
import type { PrivacyPosture } from "@/lib/data-flow";

/**
 * Local-first conversation history. The phone routes ONLY through the gateway,
 * so threads/messages persist on-device (expo-sqlite) and are never required to
 * leave it — cloud sync is opt-in and lives elsewhere. Each assistant message
 * keeps its provider/model + Tokzen `ResponseMeta` so the moat footer can be
 * rebuilt when a thread is reopened. The `gateway_thread_id` ties a local thread
 * to the gateway's server-side conversation so follow-ups keep context.
 *
 * Schema carries forward-compatible columns (project_id for Projects, privacy
 * posture for Private Mode, attachments_json for image/file turns) so those
 * features layer on without a migration.
 */

const DB_NAME = "zintus-history.db";

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync(DB_NAME).then(async (db) => {
      await db.execAsync(`
        PRAGMA journal_mode = WAL;

        CREATE TABLE IF NOT EXISTS threads (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          project_id TEXT,
          gateway_thread_id TEXT,
          default_provider TEXT,
          strategy TEXT,
          privacy_posture TEXT NOT NULL DEFAULT 'standard'
        );

        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          provider_id TEXT,
          model TEXT,
          meta_json TEXT,
          attachments_json TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_messages_thread
          ON messages (thread_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_threads_updated
          ON threads (updated_at DESC);
      `);
      return db;
    });
  }
  return dbPromise;
}

/** Time-ordered, collision-resistant id without pulling in a uuid dep. */
function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

export interface StoredAttachment {
  kind: "image" | "file";
  name: string;
  mimeType?: string;
  bytes?: number;
}

export interface Thread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  projectId: string | null;
  gatewayThreadId: string | null;
  defaultProvider: ProviderId | null;
  strategy: RoutingStrategy | null;
  privacyPosture: PrivacyPosture;
}

export interface StoredMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  providerId: ProviderId | null;
  model: string | null;
  meta: ResponseMeta | null;
  attachments: StoredAttachment[] | null;
}

interface ThreadRow {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  project_id: string | null;
  gateway_thread_id: string | null;
  default_provider: string | null;
  strategy: string | null;
  privacy_posture: string;
}

interface MessageRow {
  id: string;
  thread_id: string;
  role: string;
  content: string;
  created_at: number;
  provider_id: string | null;
  model: string | null;
  meta_json: string | null;
  attachments_json: string | null;
}

function toThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    projectId: row.project_id,
    gatewayThreadId: row.gateway_thread_id,
    defaultProvider: (row.default_provider as ProviderId | null) ?? null,
    strategy: (row.strategy as RoutingStrategy | null) ?? null,
    privacyPosture: (row.privacy_posture as PrivacyPosture) ?? "standard",
  };
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function toMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
    createdAt: row.created_at,
    providerId: (row.provider_id as ProviderId | null) ?? null,
    model: row.model,
    meta: parseJson<ResponseMeta>(row.meta_json),
    attachments: parseJson<StoredAttachment[]>(row.attachments_json),
  };
}

export interface CreateThreadInput {
  title?: string;
  projectId?: string | null;
  defaultProvider?: ProviderId | null;
  strategy?: RoutingStrategy | null;
  privacyPosture?: PrivacyPosture;
}

export async function createThread(
  input: CreateThreadInput = {},
  now = Date.now(),
): Promise<Thread> {
  const db = await getDb();
  const id = newId("thr");
  await db.runAsync(
    `INSERT INTO threads
       (id, title, created_at, updated_at, project_id, default_provider, strategy, privacy_posture)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.title?.trim() || "New chat",
    now,
    now,
    input.projectId ?? null,
    input.defaultProvider ?? null,
    input.strategy ?? null,
    input.privacyPosture ?? "standard",
  );
  return (await getThread(id))!;
}

export async function getThread(id: string): Promise<Thread | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<ThreadRow>(
    "SELECT * FROM threads WHERE id = ?",
    id,
  );
  return row ? toThread(row) : null;
}

export async function listThreads(projectId?: string | null): Promise<Thread[]> {
  const db = await getDb();
  const rows =
    projectId === undefined
      ? await db.getAllAsync<ThreadRow>(
          "SELECT * FROM threads ORDER BY updated_at DESC",
        )
      : await db.getAllAsync<ThreadRow>(
          "SELECT * FROM threads WHERE project_id IS ? ORDER BY updated_at DESC",
          projectId,
        );
  return rows.map(toThread);
}

export async function searchThreads(query: string): Promise<Thread[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return listThreads();
  }
  const db = await getDb();
  // Match thread titles OR any message content within the thread.
  const rows = await db.getAllAsync<ThreadRow>(
    `SELECT DISTINCT t.* FROM threads t
       LEFT JOIN messages m ON m.thread_id = t.id
     WHERE t.title LIKE ? OR m.content LIKE ?
     ORDER BY t.updated_at DESC`,
    `%${trimmed}%`,
    `%${trimmed}%`,
  );
  return rows.map(toThread);
}

export async function renameThread(id: string, title: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "UPDATE threads SET title = ?, updated_at = ? WHERE id = ?",
    title.trim() || "New chat",
    Date.now(),
    id,
  );
}

export async function setThreadGatewayId(
  id: string,
  gatewayThreadId: string,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    "UPDATE threads SET gateway_thread_id = ? WHERE id = ?",
    gatewayThreadId,
    id,
  );
}

export async function deleteThread(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync("DELETE FROM messages WHERE thread_id = ?", id);
  await db.runAsync("DELETE FROM threads WHERE id = ?", id);
}

export interface AppendMessageInput {
  threadId: string;
  role: "user" | "assistant";
  content: string;
  providerId?: ProviderId | null;
  model?: string | null;
  meta?: ResponseMeta | null;
  attachments?: StoredAttachment[] | null;
}

export async function appendMessage(
  input: AppendMessageInput,
  now = Date.now(),
): Promise<StoredMessage> {
  const db = await getDb();
  const id = newId("msg");
  await db.runAsync(
    `INSERT INTO messages
       (id, thread_id, role, content, created_at, provider_id, model, meta_json, attachments_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.threadId,
    input.role,
    input.content,
    now,
    input.providerId ?? null,
    input.model ?? null,
    input.meta ? JSON.stringify(input.meta) : null,
    input.attachments ? JSON.stringify(input.attachments) : null,
  );
  await db.runAsync(
    "UPDATE threads SET updated_at = ? WHERE id = ?",
    now,
    input.threadId,
  );
  return (await getMessage(id))!;
}

export interface UpdateMessagePatch {
  content?: string;
  providerId?: ProviderId | null;
  model?: string | null;
  meta?: ResponseMeta | null;
}

/** Finalize a streamed assistant message (content + provider/model + meta). */
export async function updateMessage(
  id: string,
  patch: UpdateMessagePatch,
): Promise<void> {
  const db = await getDb();
  const sets: string[] = [];
  const args: SQLite.SQLiteBindValue[] = [];
  if (patch.content !== undefined) {
    sets.push("content = ?");
    args.push(patch.content);
  }
  if (patch.providerId !== undefined) {
    sets.push("provider_id = ?");
    args.push(patch.providerId);
  }
  if (patch.model !== undefined) {
    sets.push("model = ?");
    args.push(patch.model);
  }
  if (patch.meta !== undefined) {
    sets.push("meta_json = ?");
    args.push(patch.meta ? JSON.stringify(patch.meta) : null);
  }
  if (sets.length === 0) {
    return;
  }
  args.push(id);
  await db.runAsync(
    `UPDATE messages SET ${sets.join(", ")} WHERE id = ?`,
    ...args,
  );
}

async function getMessage(id: string): Promise<StoredMessage | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<MessageRow>(
    "SELECT * FROM messages WHERE id = ?",
    id,
  );
  return row ? toMessage(row) : null;
}

export async function getMessages(threadId: string): Promise<StoredMessage[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<MessageRow>(
    "SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC",
    threadId,
  );
  return rows.map(toMessage);
}
