"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PROVIDER_IDS, type ProviderId, type RoutingStrategy } from "@zintus/types";
import { useAppStore } from "@/lib/app-store";
import { useSettingsStore } from "@/lib/store";
import {
  createProject,
  deleteProject,
  listProjects,
  setActiveProjectId,
  updateProject,
  type Project,
} from "@/lib/projects";

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
  const [form, setForm] = useState<FormState | null>(null);

  const refresh = useCallback(() => setProjects(listProjects()), []);
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
    <div className="screen" style={{ padding: 24, overflow: "auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>Projects</h1>
        <button type="button" className="chat-tool-toggle" onClick={() => setForm({ ...EMPTY })}>
          ＋ New project
        </button>
      </div>
      <p style={{ color: "#94a3b8", fontSize: 13, marginBottom: 16, maxWidth: 640 }}>
        Workspaces with shared instructions and routing defaults. A project&apos;s
        instructions are sent as a system message for every chat started from it.
      </p>

      {projects.length === 0 ? (
        <p style={{ color: "#94a3b8", fontSize: 14 }}>No projects yet.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 720 }}>
          {projects.map((p) => (
            <div
              key={p.id}
              style={{ border: "1px solid #232a36", borderRadius: 12, padding: 16, background: "#0e1118" }}
            >
              <div style={{ fontSize: 16, fontWeight: 700, color: "#e8eef5" }}>{p.name}</div>
              {p.instructions ? (
                <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 4 }}>
                  {p.instructions.slice(0, 160)}
                </div>
              ) : null}
              <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 8 }}>
                {p.defaultProvider ?? "Auto routing"}
                {p.privateDefault ? " · 🛡 Private" : ""}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button type="button" className="chat-send" style={{ width: "auto", padding: "6px 14px" }} onClick={() => openInChat(p)}>
                  New chat
                </button>
                <button
                  type="button"
                  className="chat-tool-toggle"
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
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="chat-tool-toggle"
                  onClick={() => {
                    if (window.confirm(`Delete "${p.name}"? Chats are kept.`)) {
                      deleteProject(p.id);
                      refresh();
                    }
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {form ? (
        <div className="consent-backdrop" role="dialog" aria-modal="true" onClick={() => setForm(null)}>
          <div className="consent-card" style={{ maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
            <h2 className="consent-title">{form.id ? "Edit project" : "New project"}</h2>
            <label style={{ fontSize: 12, color: "#94a3b8" }}>Name</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Mobile app"
              style={{ width: "100%", height: 36, borderRadius: 8, margin: "4px 0 10px", background: "#0b0f17", border: "1px solid #232a36", color: "#e8eef5", padding: "0 10px" }}
            />
            <label style={{ fontSize: 12, color: "#94a3b8" }}>Instructions (system prompt)</label>
            <textarea
              rows={4}
              value={form.instructions}
              onChange={(e) => setForm({ ...form, instructions: e.target.value })}
              placeholder="Shared context for every chat in this project…"
              style={{ width: "100%", borderRadius: 8, margin: "4px 0 10px", background: "#0b0f17", border: "1px solid #232a36", color: "#e8eef5", padding: 10, resize: "vertical" }}
            />
            <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 6 }}>
              <label style={{ fontSize: 12, color: "#94a3b8" }}>Default provider</label>
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
              <label style={{ fontSize: 12, color: "#94a3b8" }}>Strategy</label>
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
              <label style={{ fontSize: 12, color: "#94a3b8", marginLeft: "auto" }}>
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
