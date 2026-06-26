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
import { Card, CardContent, CardHeader, CardTitle } from "@/app/_components/ui/card";
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
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <Card className="flex min-h-0 flex-1 flex-col border-[var(--color-border)] bg-[var(--color-surface)]">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Projects</CardTitle>
          <Button type="button" onClick={() => setForm({ ...EMPTY })}>＋ New project</Button>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
          <p style={{ fontSize: 13, color: "var(--color-text-muted)", margin: 0 }}>
            Workspaces with shared instructions and routing defaults. A project&apos;s
            instructions are sent as a system message for every chat started from it.
          </p>

          {projects.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--color-text-muted)" }}>No projects yet.</p>
          ) : (
            projects.map((p) => (
              <div
                key={p.id}
                style={{
                  border: "1px solid var(--color-border)",
                  borderRadius: 12,
                  padding: 14,
                  background: "var(--color-elevated)",
                }}
              >
                <div style={{ fontSize: 16, fontWeight: 700, color: "var(--color-text)" }}>{p.name}</div>
                {p.instructions ? (
                  <div style={{ fontSize: 13, color: "var(--color-text-muted)", marginTop: 4 }}>
                    {p.instructions.slice(0, 140)}
                  </div>
                ) : null}
                <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 8 }}>
                  {p.defaultProvider ?? "Auto routing"}
                  {p.privateDefault ? " · 🛡 Private" : ""}
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
            ))
          )}
        </CardContent>
      </Card>

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
  );
}
