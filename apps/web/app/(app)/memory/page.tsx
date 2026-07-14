"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/app/_components/Icons";
import { useAppStore } from "@/lib/app-store";
import {
  createMemory,
  deleteMemory,
  listMemory,
  updateMemory,
  type MemoryFact,
  type MemoryScope,
} from "@/lib/memory-api";
import { loadMemory, saveMemory } from "@/lib/memory";
import {
  listProjects,
  getActiveProjectId,
  type Project,
} from "@/lib/projects";

/** Legacy on-device memories are freeform strings; derive a readable, stable-ish
 *  key so they render sensibly in the Manager (mirrors the "llm.<slug>" style). */
function legacyKey(entry: string): string {
  return `imported.${entry.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 32) || "note"}`;
}

const SCOPES: { id: MemoryScope; label: string; hint: string }[] = [
  { id: "global", label: "Global", hint: "Facts that apply across every chat." },
  { id: "project", label: "Project", hint: "Facts scoped to a project." },
  { id: "thread", label: "Thread", hint: "Facts tied to a single conversation." },
];

const pageStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
};

const cardStyle: CSSProperties = {
  border: "1px solid var(--color-border)",
  borderRadius: 12,
  background: "var(--color-surface)",
  padding: 14,
};

const inputStyle: CSSProperties = {
  background: "var(--color-elevated, #17171b)",
  border: "1px solid var(--color-border)",
  borderRadius: 8,
  color: "var(--color-text)",
  padding: "8px 10px",
  fontSize: 14,
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}

export default function MemoryPage() {
  const router = useRouter();
  const [scope, setScope] = useState<MemoryScope>("global");
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** Open the conversation a fact was extracted from. The fact's threadId is the
   *  GATEWAY thread id; map it to the local thread (by gatewayThreadId) and switch
   *  to it. (Message-level scroll isn't possible — client and gateway message ids
   *  differ.) */
  function openSource(fact: MemoryFact) {
    if (!fact.threadId) return;
    const { threads, switchThread } = useAppStore.getState();
    const local = threads.find((t) => t.gatewayThreadId === fact.threadId);
    if (!local) {
      setError("That conversation isn't on this device.");
      return;
    }
    switchThread(local.id);
    router.push("/chat");
  }

  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [saving, setSaving] = useState(false);

  const [editId, setEditId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  // Legacy on-device (localStorage) memories from the old settings-based system,
  // offered for one-click import into gateway-backed global memory.
  const [legacyEntries, setLegacyEntries] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);

  // Project picker (Project tab): scopes listing + creation to one project, so
  // project facts are created against a REAL project id (what the compiler filters
  // on) rather than an unscoped null.
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  // Thread picker (Thread tab): pick a conversation to view its extracted facts.
  // value = the GATEWAY thread id (what facts are keyed by), label = the title.
  const [chatThreads, setChatThreads] = useState<
    { gatewayThreadId: string; title: string }[]
  >([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);

  useEffect(() => {
    setLegacyEntries(loadMemory());
    const list = listProjects();
    setProjects(list);
    setSelectedProjectId(getActiveProjectId() ?? list[0]?.id ?? null);
    const threads = useAppStore
      .getState()
      .threads.filter((t) => t.gatewayThreadId)
      .map((t) => ({ gatewayThreadId: t.gatewayThreadId as string, title: t.title }));
    setChatThreads(threads);
    setSelectedThreadId(threads[0]?.gatewayThreadId ?? null);
  }, []);

  const load = useCallback(
    async (s: MemoryScope, opts?: { projectId?: string; threadId?: string }) => {
      setLoading(true);
      setError(null);
      try {
        setFacts(
          await listMemory({
            scope: s,
            projectId: opts?.projectId,
            threadId: opts?.threadId,
          }),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load memory.");
        setFacts([]);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Listing/creation opts for the active tab: project → the picked project, thread
  // → the picked conversation, global → none.
  const scopeOpts: { projectId?: string; threadId?: string } =
    scope === "project"
      ? { projectId: selectedProjectId ?? undefined }
      : scope === "thread"
        ? { threadId: selectedThreadId ?? undefined }
        : {};

  useEffect(() => {
    void load(scope, {
      projectId: scope === "project" ? selectedProjectId ?? undefined : undefined,
      threadId: scope === "thread" ? selectedThreadId ?? undefined : undefined,
    });
  }, [scope, selectedProjectId, selectedThreadId, load]);

  async function onCreate() {
    const key = newKey.trim();
    const value = newValue.trim();
    if (!key || !value || saving) return;
    // Project/thread facts need a real owner (what the compiler filters on) —
    // otherwise they'd never be compiled.
    if (scope === "project" && !selectedProjectId) {
      setError("Create or select a project first.");
      return;
    }
    if (scope === "thread" && !selectedThreadId) {
      setError("Select a conversation first.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createMemory({ scope, key, value, ...scopeOpts });
      setNewKey("");
      setNewValue("");
      await load(scope, scopeOpts);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save memory.");
    } finally {
      setSaving(false);
    }
  }

  async function onImportLegacy() {
    if (importing || legacyEntries.length === 0) return;
    setImporting(true);
    setError(null);
    try {
      for (const entry of legacyEntries) {
        const value = entry.trim();
        if (!value) continue;
        await createMemory({ scope: "global", key: legacyKey(value), value, source: "imported" });
      }
      saveMemory([]); // clear the old on-device store so we don't offer it again
      setLegacyEntries([]);
      setScope("global");
      await load("global");
    } catch (e) {
      setError(
        e instanceof Error
          ? `Import failed: ${e.message}`
          : "Import failed. Your on-device memories were not cleared.",
      );
    } finally {
      setImporting(false);
    }
  }

  async function onTogglePin(fact: MemoryFact) {
    try {
      await updateMemory(fact.id, { pinned: !fact.pinned });
      await load(scope, scopeOpts);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update memory.");
    }
  }

  async function onSaveEdit(id: string) {
    const value = editValue.trim();
    if (!value) return;
    try {
      await updateMemory(id, { value });
      setEditId(null);
      await load(scope, scopeOpts);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update memory.");
    }
  }

  async function onDelete(id: string) {
    try {
      await deleteMemory(id);
      setFacts((prev) => prev.filter((f) => f.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete memory.");
    }
  }

  const activeHint = SCOPES.find((s) => s.id === scope)?.hint ?? "";

  return (
    <div className="screen section-scroll">
      <div className="section-shell section-shell-wide" style={pageStyle}>
      <div>
        <h1 style={{ margin: "0 0 4px", fontSize: 22 }}>Memory</h1>
        <p style={{ margin: 0, color: "var(--color-text-sub)", fontSize: 13.5 }}>
          Your memory is yours: view, edit, pin, and delete it. Facts are{" "}
          <strong>background context</strong> the assistant may consider — never
          instructions, and never able to change its rules. Nothing is written in
          private/incognito chats.
        </p>
      </div>

      {/* Legacy migration bridge: import old on-device (localStorage) memories. */}
      {legacyEntries.length > 0 ? (
        <div
          style={{
            ...cardStyle,
            borderColor: "var(--c-accent, #6366f1)",
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div style={{ flex: 1, minWidth: 220, fontSize: 13.5 }}>
            You have <strong>{legacyEntries.length}</strong> on-device{" "}
            {legacyEntries.length === 1 ? "memory" : "memories"} from the old
            settings-based store. Import{" "}
            {legacyEntries.length === 1 ? "it" : "them"} into <strong>Global</strong>{" "}
            memory so they sync with the rest and actually influence chats.
          </div>
          <button
            onClick={() => void onImportLegacy()}
            disabled={importing}
            style={{
              padding: "8px 14px",
              borderRadius: 8,
              border: "none",
              background: "var(--c-accent, #6366f1)",
              color: "var(--c-accent-contrast, #fff)",
              fontWeight: 600,
              fontSize: 13.5,
              cursor: importing ? "default" : "pointer",
              opacity: importing ? 0.6 : 1,
            }}
          >
            {importing
              ? "Importing…"
              : `Import ${legacyEntries.length} into Global`}
          </button>
        </div>
      ) : null}

      {/* Scope tabs */}
      <div style={{ display: "flex", gap: 6 }} role="tablist">
        {SCOPES.map((s) => {
          const active = s.id === scope;
          return (
            <button
              key={s.id}
              role="tab"
              aria-selected={active}
              onClick={() => setScope(s.id)}
              style={{
                padding: "6px 12px",
                borderRadius: 999,
                border: "1px solid var(--color-border)",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                // V9 13.3: pair active ink with the accent fill.
                color: active ? "var(--c-accent-contrast)" : "var(--color-text-sub)",
                background: active
                  ? "var(--c-accent, #6366f1)"
                  : "transparent",
              }}
            >
              {s.label}
            </button>
          );
        })}
      </div>
      <p style={{ margin: "-6px 0 0", color: "var(--color-text-sub)", fontSize: 12.5 }}>
        {activeHint}
      </p>

      {/* Project picker — only on the Project tab. Scopes listing + creation to a
          real project so project facts attach to the id the compiler filters on. */}
      {scope === "project" ? (
        projects.length > 0 ? (
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <span style={{ color: "var(--color-text-sub)" }}>Project</span>
            <select
              value={selectedProjectId ?? ""}
              onChange={(e) => setSelectedProjectId(e.target.value || null)}
              style={{ ...inputStyle, flex: "0 1 260px" }}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p
            style={{
              ...cardStyle,
              color: "var(--color-text-sub)",
              fontSize: 13,
              margin: 0,
            }}
          >
            No projects yet. Create one from the{" "}
            <a href="/projects" style={{ textDecoration: "underline" }}>
              Projects
            </a>{" "}
            page, then add project memories here.
          </p>
        )
      ) : null}

      {/* Thread picker — only on the Thread tab. Pick a conversation to view its
          extracted facts (value = gateway thread id, what facts are keyed by). */}
      {scope === "thread" ? (
        chatThreads.length > 0 ? (
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <span style={{ color: "var(--color-text-sub)" }}>Conversation</span>
            <select
              value={selectedThreadId ?? ""}
              onChange={(e) => setSelectedThreadId(e.target.value || null)}
              style={{ ...inputStyle, flex: "1 1 260px" }}
            >
              {chatThreads.map((t) => (
                <option key={t.gatewayThreadId} value={t.gatewayThreadId}>
                  {t.title || "Untitled"}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p
            style={{
              ...cardStyle,
              color: "var(--color-text-sub)",
              fontSize: 13,
              margin: 0,
            }}
          >
            No synced conversations yet — start a chat, and its extracted facts
            will show here.
          </p>
        )
      ) : null}

      {/* Create */}
      <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            style={{ ...inputStyle, flex: "1 1 180px" }}
            placeholder="Key (e.g. name)"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
          />
          <input
            style={{ ...inputStyle, flex: "2 1 260px" }}
            placeholder="Value (e.g. Alice)"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void onCreate();
            }}
          />
          <button
            onClick={() => void onCreate()}
            disabled={!newKey.trim() || !newValue.trim() || saving}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 14px",
              borderRadius: 8,
              border: "none",
              background: "var(--c-accent, #6366f1)",
              color: "var(--c-accent-contrast, #fff)",
              fontWeight: 600,
              fontSize: 13.5,
              cursor: saving ? "default" : "pointer",
              opacity: !newKey.trim() || !newValue.trim() || saving ? 0.6 : 1,
            }}
          >
            <Icon name="plus" size={15} /> Save memory
          </button>
        </div>
      </div>

      {error ? (
        <div
          style={{
            ...cardStyle,
            borderColor: "var(--color-red, #ef4444)",
            color: "var(--color-red, #ef4444)",
            fontSize: 13.5,
          }}
        >
          {error}
        </div>
      ) : null}

      {/* List */}
      {loading ? (
        <p style={{ color: "var(--color-text-sub)", fontSize: 13.5 }}>Loading…</p>
      ) : facts.length === 0 ? (
        <div style={{ ...cardStyle, color: "var(--color-text-sub)", fontSize: 13.5 }}>
          No {scope} memories yet.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {facts.map((fact) => (
            <div key={fact.id} style={{ ...cardStyle, display: "flex", gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  {fact.pinned ? (
                    <span
                      title="Pinned"
                      style={{ color: "var(--c-accent, #6366f1)", fontSize: 12 }}
                    >
                      ★
                    </span>
                  ) : null}
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{fact.key}</span>
                </div>
                {editId === fact.id ? (
                  <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                    <input
                      autoFocus
                      style={{ ...inputStyle, flex: 1 }}
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void onSaveEdit(fact.id);
                        if (e.key === "Escape") setEditId(null);
                      }}
                    />
                    <button
                      onClick={() => void onSaveEdit(fact.id)}
                      title="Save"
                      style={iconBtn}
                    >
                      <Icon name="check" size={14} />
                    </button>
                    <button
                      onClick={() => setEditId(null)}
                      title="Cancel"
                      style={iconBtn}
                    >
                      <Icon name="x" size={14} />
                    </button>
                  </div>
                ) : (
                  <div style={{ fontSize: 13.5, color: "var(--color-text-sub)", marginTop: 2 }}>
                    {fact.value}
                  </div>
                )}
                <div style={{ fontSize: 11.5, color: "var(--color-text-muted, #71717a)", marginTop: 4 }}>
                  {fact.source ? `via ${fact.source} · ` : ""}
                  updated {fmtDate(fact.updatedAt)}
                  {fact.lastUsedAt
                    ? ` · last used ${fmtDate(new Date(fact.lastUsedAt).toISOString())}`
                    : " · not yet used"}
                  {fact.sourceMessageId ? (
                    fact.threadId ? (
                      <>
                        {" · "}
                        <button
                          type="button"
                          onClick={() => openSource(fact)}
                          title="Open the conversation this was extracted from"
                          style={{
                            background: "none",
                            border: "none",
                            padding: 0,
                            font: "inherit",
                            color: "var(--c-accent, #6366f1)",
                            cursor: "pointer",
                            textDecoration: "underline",
                          }}
                        >
                          from a chat message
                        </button>
                      </>
                    ) : (
                      <span title={`Extracted from message ${fact.sourceMessageId}`}>
                        {" · from a chat message"}
                      </span>
                    )
                  ) : null}
                </div>
              </div>
              {editId === fact.id ? null : (
                <div style={{ display: "flex", gap: 4, alignItems: "flex-start" }}>
                  <button
                    onClick={() => void onTogglePin(fact)}
                    title={fact.pinned ? "Unpin" : "Pin"}
                    style={iconBtn}
                  >
                    <span style={{ fontSize: 13 }}>{fact.pinned ? "★" : "☆"}</span>
                  </button>
                  <button
                    onClick={() => {
                      setEditId(fact.id);
                      setEditValue(fact.value);
                    }}
                    title="Edit"
                    style={iconBtn}
                  >
                    <Icon name="pencil" size={13} />
                  </button>
                  <button
                    onClick={() => void onDelete(fact.id)}
                    title="Delete"
                    style={{ ...iconBtn, color: "var(--color-red, #ef4444)" }}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}

const iconBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 28,
  height: 28,
  borderRadius: 7,
  border: "1px solid var(--color-border)",
  background: "transparent",
  color: "var(--color-text-sub)",
  cursor: "pointer",
};
