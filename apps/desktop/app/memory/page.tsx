"use client";

/**
 * Memory manage page — reached from Settings (deliberately NOT in the sidebar,
 * per the approved design). Lists what the LOCAL gateway remembers across
 * chats; every fact can be pinned, forgotten, or all cleared. On-device data,
 * never used to train anything.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Pin, PinOff } from "lucide-react";
import {
  deleteMemory,
  listMemory,
  updateMemory,
  type MemoryFact,
} from "@/lib/memory-api";

export default function MemoryPage() {
  const [facts, setFacts] = useState<MemoryFact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setError(null);
      setFacts(await listMemory({ scope: "global" }));
    } catch (err) {
      setFacts([]);
      setError(err instanceof Error ? err.message : "Could not load memory");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function forget(id: string) {
    setBusy(id);
    try {
      await deleteMemory(id);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusy(null);
    }
  }

  async function togglePin(fact: MemoryFact) {
    setBusy(fact.id);
    try {
      await updateMemory(fact.id, { pinned: !fact.pinned });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setBusy(null);
    }
  }

  async function clearAll() {
    if (!facts || facts.length === 0) return;
    if (!window.confirm(`Forget all ${facts.length} memories? This can't be undone.`)) return;
    setBusy("all");
    try {
      for (const fact of facts) await deleteMemory(fact.id);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Clear failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14, maxWidth: 760 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Link
          href="/settings"
          aria-label="Back to Settings"
          style={{
            display: "grid",
            placeItems: "center",
            width: 28,
            height: 28,
            borderRadius: 8,
            border: "1px solid var(--color-border)",
            color: "var(--color-text-sub)",
          }}
        >
          <ArrowLeft size={14} />
        </Link>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Memory</h1>
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            color: "var(--color-green)",
            background: "color-mix(in srgb, var(--color-green) 12%, transparent)",
            padding: "2px 8px",
            borderRadius: 999,
          }}
        >
          on-device
        </span>
        <span style={{ flex: 1 }} />
        {facts && facts.length > 0 ? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void clearAll()}
            style={{
              height: 30,
              padding: "0 12px",
              border: "1px solid var(--color-border)",
              borderRadius: 8,
              background: "transparent",
              color: "var(--color-red)",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {busy === "all" ? "Clearing…" : "Clear all"}
          </button>
        ) : null}
      </div>

      <p style={{ margin: 0, fontSize: 13, color: "var(--color-text-sub)", lineHeight: 1.5 }}>
        What Zintus remembers across chats — background facts your local gateway stores on
        this machine (never instructions, never training data). Replies that used a memory
        say so in their receipt.
      </p>

      {error ? (
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--color-red)" }}>{error}</p>
      ) : null}

      {facts === null ? (
        <p style={{ fontSize: 13, color: "var(--color-text-muted)" }}>Loading…</p>
      ) : facts.length === 0 && !error ? (
        <div
          style={{
            padding: "28px 16px",
            textAlign: "center",
            color: "var(--color-text-muted)",
            fontSize: 13,
            border: "1px dashed var(--color-border)",
            borderRadius: 12,
          }}
        >
          Nothing remembered yet — memories accumulate as you chat.
        </div>
      ) : (
        facts.map((fact) => (
          <div
            key={fact.id}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 10,
              border: "1px solid var(--color-border)",
              borderRadius: 10,
              padding: "10px 12px",
              background: "var(--color-surface)",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text)" }}>
                {fact.key}
                {fact.pinned ? (
                  <Pin size={11} style={{ marginLeft: 6, color: "var(--color-purple-bright)" }} />
                ) : null}
              </div>
              <div style={{ fontSize: 12.5, color: "var(--color-text-sub)", marginTop: 2 }}>
                {fact.value}
              </div>
              <div
                style={{
                  fontSize: 10.5,
                  color: "var(--color-text-muted)",
                  marginTop: 4,
                  fontFamily: "var(--font-mono)",
                }}
              >
                {new Date(fact.createdAt).toLocaleDateString()}
                {fact.source ? ` · from ${fact.source}` : ""}
              </div>
            </div>
            <button
              type="button"
              title={fact.pinned ? "Unpin (may be pruned over time)" : "Pin (always kept)"}
              disabled={busy !== null}
              onClick={() => void togglePin(fact)}
              style={{
                border: "none",
                background: "transparent",
                color: "var(--color-text-sub)",
                cursor: "pointer",
                padding: 4,
              }}
            >
              {fact.pinned ? <PinOff size={14} /> : <Pin size={14} />}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void forget(fact.id)}
              style={{
                height: 26,
                padding: "0 10px",
                border: "1px solid var(--color-border)",
                borderRadius: 7,
                background: "transparent",
                color: "var(--color-text-sub)",
                fontSize: 11.5,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {busy === fact.id ? "…" : "Forget"}
            </button>
          </div>
        ))
      )}
    </div>
  );
}
