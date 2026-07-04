"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PROVIDER_IDS, type ProviderId } from "@zintus/types";
import {
  createProject,
  deleteProject,
  listProjects,
  setActiveProjectId,
  updateProject,
  type Project,
} from "@/lib/projects";
import { useChatStore, useProviderStatusStore, useSettingsStore } from "@/lib/store";
import { Button } from "@/app/_components/ui/button";
import { Textarea } from "@/app/_components/ui/textarea";

interface FormState {
  id: string | null;
  name: string;
  instructions: string;
  defaultProvider: ProviderId | "auto";
  privateDefault: boolean;
}

const EMPTY: FormState = {
  id: null,
  name: "",
  instructions: "",
  defaultProvider: "auto",
  privateDefault: false,
};

export default function ProjectsPage() {
  const router = useRouter();
  const newChat = useChatStore((s) => s.newChat);
  const setSelectedProvider = useProviderStatusStore((s) => s.setSelectedProvider);
  const updateSettings = useSettingsStore((s) => s.update);
  const [projects, setProjects] = useState<Project[]>([]);
  const [form, setForm] = useState<FormState | null>(null);

  const refresh = useCallback(() => setProjects(listProjects()), []);
  useEffect(() => refresh(), [refresh]);

  function save() {
    if (!form) return;
    const input = {
      name: form.name,
      instructions: form.instructions,
      defaultProvider: form.defaultProvider === "auto" ? null : form.defaultProvider,
      privateDefault: form.privateDefault,
    };
    if (form.id) updateProject(form.id, input);
    else createProject(input);
    setForm(null);
    refresh();
  }

  function useInChat(project: Project) {
    setActiveProjectId(project.id);
    // Start a FRESH thread so the project's instructions actually inject
    // (ChatPanel only injects on an empty thread), and apply its routing
    // defaults — otherwise the project would silently no-op in a busy thread.
    newChat();
    if (project.defaultProvider) setSelectedProvider(project.defaultProvider);
    if (project.privateDefault) updateSettings({ blockTrainingProviders: true });
    router.push("/chat");
  }

  return (
    <div className="scroll" style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
      <div style={{ maxWidth: 760, margin: "0 auto", width: "100%", padding: "22px 24px 60px", display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Projects</h1>
          <button type="button" className="ghostbtn" style={{ marginLeft: "auto" }} onClick={() => setForm({ ...EMPTY })}>
            + New project
          </button>
        </div>
          <p style={{ fontSize: 12.5, color: "var(--color-text-sub)", margin: 0 }}>
            Workspaces with shared instructions and routing defaults. A project&apos;s
            instructions are sent as a system message for every chat started from it.
          </p>

          {projects.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--color-text-muted)" }}>No projects yet.</p>
          ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {projects.map((p) => (
              <div
                key={p.id}
                style={{
                  border: "1px solid var(--color-border)",
                  borderRadius: 12,
                  padding: "14px 16px",
                  background: "var(--color-surface)",
                }}
              >
                <div style={{ fontSize: 13.5, fontWeight: 650, color: "var(--color-text)" }}>{p.name}</div>
                {p.instructions ? (
                  <div style={{ fontSize: 12.5, color: "var(--color-text-sub)", marginTop: 2 }}>
                    {p.instructions.slice(0, 140)}
                  </div>
                ) : null}
                <div style={{ marginTop: 8 }}>
                  <span
                    title="Project-scoped default route"
                    style={{
                      fontSize: 10.5,
                      padding: "2px 8px",
                      borderRadius: 999,
                      fontWeight: 600,
                      color: "var(--color-purple-bright)",
                      background: "var(--color-purple-faint)",
                    }}
                  >
                    route: {p.defaultProvider ?? "auto"}
                  </span>
                  {p.privateDefault ? (
                    <span
                      style={{
                        fontSize: 10.5,
                        padding: "2px 8px",
                        borderRadius: 999,
                        fontWeight: 600,
                        marginLeft: 6,
                        color: "var(--color-green)",
                        background: "color-mix(in srgb, var(--color-green) 12%, transparent)",
                      }}
                    >
                      private
                    </span>
                  ) : null}
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                  <Button type="button" onClick={() => useInChat(p)}>New chat</Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() =>
                      setForm({
                        id: p.id,
                        name: p.name,
                        instructions: p.instructions,
                        defaultProvider: p.defaultProvider ?? "auto",
                        privateDefault: p.privateDefault,
                      })
                    }
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      if (window.confirm(`Delete "${p.name}"? Chats are kept.`)) {
                        deleteProject(p.id);
                        refresh();
                      }
                    }}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </div>
          )}

      {form && (
        <div className="consent-backdrop" role="dialog" aria-modal="true">
          <div className="consent-card" style={{ maxWidth: 520 }}>
            <h2 className="consent-title">{form.id ? "Edit project" : "New project"}</h2>
            <label style={{ fontSize: 12, color: "var(--color-text-muted)" }}>Name</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Mobile app"
              style={{
                width: "100%", height: 36, borderRadius: 8, marginTop: 4, marginBottom: 10,
                background: "var(--color-elevated)", border: "1px solid var(--color-border)",
                color: "var(--color-text)", padding: "0 10px",
              }}
            />
            <label style={{ fontSize: 12, color: "var(--color-text-muted)" }}>Instructions (system prompt)</label>
            <Textarea
              rows={4}
              value={form.instructions}
              onChange={(e) => setForm({ ...form, instructions: e.target.value })}
              placeholder="Shared context for every chat in this project…"
            />
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10 }}>
              <label style={{ fontSize: 12, color: "var(--color-text-muted)" }}>Default provider</label>
              <select
                value={form.defaultProvider}
                onChange={(e) =>
                  setForm({ ...form, defaultProvider: e.target.value as ProviderId | "auto" })
                }
                className="h-9 rounded-md border border-[var(--color-border)] bg-[var(--color-elevated)] px-2 text-sm"
              >
                <option value="auto">Auto</option>
                {PROVIDER_IDS.map((id) => (
                  <option key={id} value={id}>{id}</option>
                ))}
              </select>
              <label style={{ fontSize: 12, color: "var(--color-text-muted)", marginLeft: "auto" }}>
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
              <Button type="button" variant="secondary" onClick={() => setForm(null)}>Cancel</Button>
              <Button type="button" onClick={save} disabled={!form.name.trim()}>Save</Button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
