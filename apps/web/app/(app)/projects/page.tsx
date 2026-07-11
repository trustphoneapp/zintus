"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PROVIDER_IDS, type ProviderId, type RoutingStrategy } from "@zintus/types";
import { useAppStore } from "@/lib/app-store";
import { useSettingsStore } from "@/lib/store";
import {
  createProject,
  deleteProject,
  getActiveProjectId,
  listProjects,
  setActiveProjectId,
  updateProject,
  type Project,
} from "@/lib/projects";

function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "recently";
  }
}

interface FormState {
  id: string | null;
  name: string;
  instructions: string;
  defaultProvider: ProviderId | "auto";
  strategy: RoutingStrategy | "default";
  privateDefault: boolean;
}

const EMPTY: FormState = {
  id: null,
  name: "",
  instructions: "",
  defaultProvider: "auto",
  strategy: "default",
  privateDefault: false,
};

export default function ProjectsPage() {
  const router = useRouter();
  const newChat = useAppStore((s) => s.newChat);
  const setSelectedProvider = useAppStore((s) => s.setSelectedProvider);
  const updateSettings = useSettingsStore((s) => s.update);

  const [projects, setProjects] = useState<Project[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);

  const refresh = useCallback(() => {
    setProjects(listProjects());
    setActiveId(getActiveProjectId());
  }, []);
  useEffect(() => refresh(), [refresh]);

  function save() {
    if (!form) return;
    const input = {
      name: form.name,
      instructions: form.instructions,
      defaultProvider: form.defaultProvider === "auto" ? null : form.defaultProvider,
      strategy: form.strategy === "default" ? null : form.strategy,
      privateDefault: form.privateDefault,
    };
    if (form.id) updateProject(form.id, input);
    else createProject(input);
    setForm(null);
    refresh();
  }

  function openInChat(project: Project) {
    setActiveProjectId(project.id);
    // Fresh thread so the project's instructions inject (leading system msg),
    // and apply its routing defaults.
    newChat(false);
    if (project.defaultProvider) setSelectedProvider(project.defaultProvider);
    if (project.strategy) updateSettings({ routingStrategy: project.strategy });
    if (project.privateDefault) updateSettings({ blockTrainingProviders: true });
    router.push("/chat");
  }

  return (
    <div className="screen" style={{ padding: 0, overflow: "auto" }}>
      <div style={{ maxWidth: 940, margin: "0 auto", padding: "28px 24px 48px" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 16,
          }}
        >
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: "-0.01em" }}>
              Projects
            </h1>
            <p
              style={{
                margin: "8px 0 0",
                fontSize: 14.5,
                lineHeight: 1.6,
                color: "var(--color-text-sub)",
                maxWidth: 600,
              }}
            >
              Group related chats with shared context and files. Every chat in a project
              sees the project&apos;s knowledge.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setForm({ ...EMPTY })}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              height: 34,
              padding: "0 13px",
              borderRadius: 9,
              border: "none",
              background: "var(--c-accent)",
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              flexShrink: 0,
              whiteSpace: "nowrap",
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" style={{ strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }}>
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            New project
          </button>
        </div>

        <p style={{ margin: "12px 0 0", fontSize: 12, color: "var(--color-text-muted)" }}>
          Local-only — projects live in this browser; no cloud sync yet.
        </p>

        {projects.length === 0 ? (
          <div
            style={{
              marginTop: 24,
              padding: "36px 24px",
              borderRadius: 14,
              border: "0.5px solid var(--c-border)",
              background: "var(--color-surface)",
              textAlign: "center",
            }}
          >
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 44,
                height: 44,
                borderRadius: 12,
                background: "var(--c-accent-light)",
                color: "var(--c-accent)",
                marginBottom: 12,
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" style={{ strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }}>
                <polygon points="12 2 2 7 12 12 22 7 12 2" />
                <polyline points="2 17 12 22 22 17" />
                <polyline points="2 12 12 17 22 12" />
              </svg>
            </div>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--color-text)" }}>
              No projects yet
            </div>
            <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--color-text-muted)" }}>
              Create one to group related chats.
            </p>
          </div>
        ) : (
          <div
            style={{
              marginTop: 24,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: 14,
            }}
          >
            {projects.map((p) => {
              const isActive = p.id === activeId;
              return (
                <div
                  key={p.id}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    padding: 18,
                    borderRadius: 14,
                    background: "var(--color-surface)",
                    border: `0.5px solid ${isActive ? "var(--c-accent)" : "var(--c-border)"}`,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 36,
                        height: 36,
                        borderRadius: 10,
                        flexShrink: 0,
                        background: "var(--c-accent-light)",
                        color: "var(--c-accent)",
                      }}
                    >
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" style={{ strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }}>
                        <polygon points="12 2 2 7 12 12 22 7 12 2" />
                        <polyline points="2 17 12 22 22 17" />
                        <polyline points="2 12 12 17 22 12" />
                      </svg>
                    </span>
                    <span style={{ fontSize: 15, fontWeight: 700, color: "var(--color-text)", flex: 1, minWidth: 0 }}>
                      {p.name}
                    </span>
                    {isActive ? (
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 5,
                          fontSize: 11,
                          fontWeight: 600,
                          color: "var(--color-green)",
                          flexShrink: 0,
                        }}
                      >
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--color-green)" }} />
                        Active
                      </span>
                    ) : null}
                  </div>

                  <p
                    style={{
                      margin: "11px 0 0",
                      fontSize: 13,
                      lineHeight: 1.55,
                      color: "var(--color-text-muted)",
                      minHeight: 38,
                    }}
                  >
                    {p.instructions
                      ? p.instructions.slice(0, 160)
                      : "No instructions yet."}
                  </p>

                  <div
                    style={{
                      marginTop: 14,
                      display: "flex",
                      alignItems: "center",
                      flexWrap: "wrap",
                      gap: 8,
                      fontSize: 12,
                      color: "var(--color-text-muted)",
                    }}
                  >
                    <span>{p.defaultProvider ?? "Auto routing"}</span>
                    {p.privateDefault ? (
                      <>
                        <span style={{ opacity: 0.5 }}>·</span>
                        <span>🛡 Private</span>
                      </>
                    ) : null}
                    <span style={{ opacity: 0.5 }}>·</span>
                    <span>{formatDate(p.createdAt)}</span>
                  </div>

                  <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                    <button
                      type="button"
                      onClick={() => openInChat(p)}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        height: 32,
                        padding: "0 13px",
                        borderRadius: 8,
                        border: "none",
                        background: "var(--c-accent)",
                        color: "#fff",
                        fontSize: 12.5,
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                    >
                      New chat
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setForm({
                          id: p.id,
                          name: p.name,
                          instructions: p.instructions,
                          defaultProvider: p.defaultProvider ?? "auto",
                          strategy: p.strategy ?? "default",
                          privateDefault: p.privateDefault,
                        })
                      }
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        height: 32,
                        padding: "0 13px",
                        borderRadius: 8,
                        border: "0.5px solid var(--c-border)",
                        background: "transparent",
                        color: "var(--color-text-sub)",
                        fontSize: 12.5,
                        fontWeight: 500,
                        cursor: "pointer",
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm(`Delete "${p.name}"? Chats are kept.`)) {
                          deleteProject(p.id);
                          refresh();
                        }
                      }}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        height: 32,
                        padding: "0 13px",
                        borderRadius: 8,
                        border: "0.5px solid var(--c-border)",
                        background: "transparent",
                        color: "var(--color-text-muted)",
                        fontSize: 12.5,
                        fontWeight: 500,
                        cursor: "pointer",
                        marginLeft: "auto",
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {form ? (
        <div className="consent-backdrop" role="dialog" aria-modal="true" onClick={() => setForm(null)}>
          <div className="consent-card" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
            <h2 className="consent-title">{form.id ? "Edit project" : "New project"}</h2>
            <label style={{ fontSize: 12, color: "var(--color-text-sub)" }}>Name</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Mobile app"
              style={{ width: "100%", height: 36, borderRadius: 8, margin: "4px 0 10px", background: "#0b0f17", border: "1px solid #232a36", color: "#e8eef5", padding: "0 10px" }}
            />
            <label style={{ fontSize: 12, color: "var(--color-text-sub)" }}>Instructions (system prompt)</label>
            <textarea
              rows={4}
              value={form.instructions}
              onChange={(e) => setForm({ ...form, instructions: e.target.value })}
              placeholder="Shared context for every chat in this project…"
              style={{ width: "100%", borderRadius: 8, margin: "4px 0 10px", background: "#0b0f17", border: "1px solid #232a36", color: "#e8eef5", padding: 10, resize: "vertical" }}
            />
            <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 6 }}>
              <label style={{ fontSize: 12, color: "var(--color-text-sub)" }}>Default provider</label>
              <select
                value={form.defaultProvider}
                onChange={(e) => setForm({ ...form, defaultProvider: e.target.value as ProviderId | "auto" })}
                style={{ height: 34, borderRadius: 8, background: "#0b0f17", border: "1px solid #232a36", color: "#e8eef5", padding: "0 8px" }}
              >
                <option value="auto">Auto</option>
                {PROVIDER_IDS.map((id) => (
                  <option key={id} value={id}>{id}</option>
                ))}
              </select>
              <label style={{ fontSize: 12, color: "var(--color-text-sub)" }}>Strategy</label>
              <select
                value={form.strategy}
                onChange={(e) => setForm({ ...form, strategy: e.target.value as RoutingStrategy | "default" })}
                style={{ height: 34, borderRadius: 8, background: "#0b0f17", border: "1px solid #232a36", color: "#e8eef5", padding: "0 8px" }}
              >
                <option value="default">Default</option>
                <option value="fastest">Fastest</option>
                <option value="economy">Economy</option>
                <option value="quality">Quality</option>
                <option value="capability">Capability</option>
                <option value="balanced">Balanced</option>
              </select>
              <label style={{ fontSize: 12, color: "var(--color-text-sub)", marginLeft: "auto" }}>
                <input
                  type="checkbox"
                  checked={form.privateDefault}
                  onChange={(e) => setForm({ ...form, privateDefault: e.target.checked })}
                  style={{ marginRight: 6 }}
                />
                🛡 Private
              </label>
            </div>
            <div className="consent-actions">
              <button type="button" className="chat-tool-toggle" onClick={() => setForm(null)}>Cancel</button>
              <button type="button" className="chat-tool-toggle" disabled={!form.name.trim()} onClick={save}>Save</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
