import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type {
  ChatMessage,
  RequestTrace,
  Thread,
  ThreadMessage,
  TraceAttempt,
} from "@zintus/types";
import * as schema from "./schema.js";

const DEFAULT_CONVERSATIONS_PATH = join(
  homedir(),
  ".zintus",
  "conversations.db",
);

export class ConversationStore {
  private readonly db;

  constructor(dbPath = DEFAULT_CONVERSATIONS_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const sqlite = new Database(dbPath, { create: true });
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        provider_id TEXT,
        model TEXT,
        trace_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS traces (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        winner_provider_id TEXT,
        winner_model TEXT,
        total_latency_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS trace_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        latency_ms INTEGER NOT NULL,
        error_code INTEGER,
        error_message TEXT
      );
      CREATE TABLE IF NOT EXISTS thread_memory (
        thread_id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        facts_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.db = drizzle(sqlite, { schema });
  }

  createThread(title = "New chat"): Thread {
    const now = Date.now();
    const thread: Thread = {
      id: randomUUID(),
      title,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    };
    this.db.insert(schema.threads).values({
      id: thread.id,
      title: thread.title,
      createdAt: now,
      updatedAt: now,
    }).run();
    return thread;
  }

  listThreads(limit = 50): Thread[] {
    const rows = this.db
      .select()
      .from(schema.threads)
      .orderBy(desc(schema.threads.updatedAt))
      .limit(limit)
      .all();
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    }));
  }

  getThreadMessages(threadId: string): ThreadMessage[] {
    const rows = this.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.threadId, threadId))
      .orderBy(schema.messages.createdAt)
      .all();
    return rows.map((row) => ({
      id: row.id,
      threadId: row.threadId,
      role: row.role as ChatMessage["role"],
      content: row.content,
      providerId: row.providerId ?? undefined,
      model: row.model ?? undefined,
      traceId: row.traceId ?? undefined,
      createdAt: new Date(row.createdAt),
    }));
  }

  appendMessage(
    threadId: string,
    message: ChatMessage,
    meta?: { providerId?: string; model?: string; traceId?: string },
  ): ThreadMessage {
    const now = Date.now();
    const row: ThreadMessage = {
      id: randomUUID(),
      threadId,
      role: message.role,
      content: message.content,
      providerId: meta?.providerId,
      model: meta?.model,
      traceId: meta?.traceId,
      createdAt: new Date(now),
    };
    this.db.insert(schema.messages).values({
      id: row.id,
      threadId: row.threadId,
      role: row.role,
      content: row.content,
      providerId: row.providerId ?? null,
      model: row.model ?? null,
      traceId: row.traceId ?? null,
      createdAt: now,
    }).run();
    this.db
      .update(schema.threads)
      .set({ updatedAt: now })
      .where(eq(schema.threads.id, threadId))
      .run();
    return row;
  }

  startTrace(traceId: string): void {
    this.db.insert(schema.traces).values({
      id: traceId,
      startedAt: Date.now(),
    }).run();
  }

  recordAttempt(traceId: string, attempt: TraceAttempt): void {
    this.db.insert(schema.traceAttempts).values({
      traceId,
      providerId: attempt.providerId,
      model: attempt.model,
      status: attempt.status,
      latencyMs: attempt.latencyMs,
      errorCode: attempt.errorCode ?? null,
      errorMessage: attempt.errorMessage ?? null,
    }).run();
  }

  completeTrace(traceId: string, trace: Omit<RequestTrace, "traceId" | "attempts">): void {
    this.db
      .update(schema.traces)
      .set({
        completedAt: trace.completedAt?.getTime() ?? Date.now(),
        winnerProviderId: trace.winner?.providerId ?? null,
        winnerModel: trace.winner?.model ?? null,
        totalLatencyMs: trace.totalLatencyMs ?? null,
      })
      .where(eq(schema.traces.id, traceId))
      .run();
  }

  getTrace(traceId: string): RequestTrace | null {
    const traceRow = this.db
      .select()
      .from(schema.traces)
      .where(eq(schema.traces.id, traceId))
      .get();
    if (!traceRow) {
      return null;
    }
    const attemptRows = this.db
      .select()
      .from(schema.traceAttempts)
      .where(eq(schema.traceAttempts.traceId, traceId))
      .all();
    const attempts: TraceAttempt[] = attemptRows.map((row) => ({
      providerId: row.providerId as TraceAttempt["providerId"],
      model: row.model,
      status: row.status as TraceAttempt["status"],
      latencyMs: row.latencyMs,
      errorCode: row.errorCode ?? undefined,
      errorMessage: row.errorMessage ?? undefined,
    }));
    return {
      traceId,
      startedAt: new Date(traceRow.startedAt),
      completedAt: traceRow.completedAt
        ? new Date(traceRow.completedAt)
        : undefined,
      attempts,
      winner:
        traceRow.winnerProviderId && traceRow.winnerModel
          ? {
              providerId: traceRow.winnerProviderId as TraceAttempt["providerId"],
              model: traceRow.winnerModel,
            }
          : undefined,
      totalLatencyMs: traceRow.totalLatencyMs ?? undefined,
    };
  }

  getLastTrace(): RequestTrace | null {
    const traceRow = this.db
      .select()
      .from(schema.traces)
      .orderBy(desc(schema.traces.startedAt))
      .limit(1)
      .get();
    if (!traceRow) {
      return null;
    }
    return this.getTrace(traceRow.id);
  }

  /** The most recent `limit` traces, newest first (for the trace list API). */
  listTraces(limit: number): RequestTrace[] {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit) || 20));
    const rows = this.db
      .select()
      .from(schema.traces)
      .orderBy(desc(schema.traces.startedAt))
      .limit(safeLimit)
      .all();
    return rows
      .map((row) => this.getTrace(row.id))
      .filter((trace): trace is RequestTrace => trace !== null);
  }

  /** Release the underlying SQLite handle. Idempotent enough for shutdown:
   *  the caller (Engine.close) guards against a double close. */
  close(): void {
    this.db.$client.close();
  }

}
