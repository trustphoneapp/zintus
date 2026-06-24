// MIT License — see LICENSE file
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";

export interface CCRStore {
  store(
    content: string,
    contentType: string,
    opts?: { sessionId?: string; originalTokens?: number; compressedTokens?: number; ttl?: number },
  ): string;
  retrieve(hash: string): string | null;
  delete(hash: string): void;
  close(): void;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** Base dir for tokzen on-disk state. TOKZEN_HOME overrides it (test isolation
 *  / read-only-home environments); defaults to ~/.tokzen. */
function tokzenHome(): string {
  return process.env.TOKZEN_HOME?.trim() || join(homedir(), ".tokzen");
}

export function createCCRStore(dbPath?: string): CCRStore {
  const resolvedPath = dbPath ?? join(tokzenHome(), "ccr.db");
  mkdirSync(dirname(resolvedPath), { recursive: true });

  const db = new Database(resolvedPath);

  db.run(`
    CREATE TABLE IF NOT EXISTS ccr_store (
      hash              TEXT PRIMARY KEY,
      content           TEXT NOT NULL,
      content_type      TEXT NOT NULL,
      compressed_tokens INTEGER,
      original_tokens   INTEGER,
      created_at        INTEGER NOT NULL,
      last_accessed     INTEGER,
      session_id        TEXT,
      ttl               INTEGER NOT NULL DEFAULT 3600
    );
    CREATE INDEX IF NOT EXISTS idx_session ON ccr_store(session_id);
    CREATE INDEX IF NOT EXISTS idx_created ON ccr_store(created_at);
  `);

  function cleanup(): void {
    db.run(`DELETE FROM ccr_store WHERE created_at + ttl < unixepoch()`);
  }

  return {
    store(content, contentType, opts = {}): string {
      cleanup();
      const hash = sha256(content);
      const now = Math.floor(Date.now() / 1000);
      db.run(
        `INSERT OR REPLACE INTO ccr_store
          (hash, content, content_type, compressed_tokens, original_tokens,
           created_at, session_id, ttl)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          hash,
          content,
          contentType,
          opts.compressedTokens ?? 0,
          opts.originalTokens ?? 0,
          now,
          opts.sessionId ?? null,
          opts.ttl ?? 3600,
        ],
      );
      return hash;
    },

    retrieve(hash): string | null {
      cleanup();
      const now = Math.floor(Date.now() / 1000);
      db.run(`UPDATE ccr_store SET last_accessed = ? WHERE hash = ?`, [now, hash]);
      const row = db
        .query<{ content: string }, [string]>(
          `SELECT content FROM ccr_store WHERE hash = ?`,
        )
        .get(hash);
      return row?.content ?? null;
    },

    delete(hash): void {
      db.run(`DELETE FROM ccr_store WHERE hash = ?`, [hash]);
    },

    close(): void {
      db.close();
    },
  };
}

let _defaultStore: CCRStore | null = null;

export function getDefaultCCRStore(): CCRStore {
  if (!_defaultStore) {
    _defaultStore = createCCRStore();
  }
  return _defaultStore;
}
