import type { ProviderId, RoutingStrategy } from "@zintus/types";

/**
 * Projects / workspaces — shared instructions + routing defaults for a set of
 * chats. localStorage-backed (parity with mobile + desktop). The active
 * project's `instructions` are injected as a leading system message in the chat
 * composer (alongside memory/presets), and its defaults seed provider/strategy/
 * privacy. Pure client feature; no gateway change.
 */

const KEY = "zintus:web-projects.v1";
const ACTIVE_KEY = "zintus:web-active-project";

export interface Project {
  id: string;
  name: string;
  instructions: string;
  defaultProvider: ProviderId | null;
  strategy: RoutingStrategy | null;
  privateDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

function readAll(): Project[] {
  if (typeof localStorage === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as Project[];
  } catch {
    return [];
  }
}

function writeAll(projects: Project[]): void {
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(KEY, JSON.stringify(projects));
  }
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `prj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function listProjects(): Project[] {
  return readAll().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getProject(id: string | null): Project | null {
  if (!id) return null;
  return readAll().find((p) => p.id === id) ?? null;
}

export interface ProjectInput {
  name: string;
  instructions?: string;
  defaultProvider?: ProviderId | null;
  strategy?: RoutingStrategy | null;
  privateDefault?: boolean;
}

export function createProject(input: ProjectInput): Project {
  const now = Date.now();
  const project: Project = {
    id: newId(),
    name: input.name.trim() || "Untitled project",
    instructions: input.instructions?.trim() ?? "",
    defaultProvider: input.defaultProvider ?? null,
    strategy: input.strategy ?? null,
    privateDefault: input.privateDefault ?? false,
    createdAt: now,
    updatedAt: now,
  };
  writeAll([project, ...readAll()]);
  return project;
}

export function updateProject(id: string, patch: ProjectInput): void {
  writeAll(
    readAll().map((p) =>
      p.id === id
        ? {
            ...p,
            name: patch.name.trim() || p.name,
            instructions: patch.instructions?.trim() ?? "",
            defaultProvider: patch.defaultProvider ?? null,
            strategy: patch.strategy ?? null,
            privateDefault: patch.privateDefault ?? false,
            updatedAt: Date.now(),
          }
        : p,
    ),
  );
}

export function deleteProject(id: string): void {
  writeAll(readAll().filter((p) => p.id !== id));
  if (getActiveProjectId() === id) setActiveProjectId(null);
}

export function getActiveProjectId(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(ACTIVE_KEY) || null;
}

export function setActiveProjectId(id: string | null): void {
  if (typeof localStorage === "undefined") return;
  if (id) localStorage.setItem(ACTIVE_KEY, id);
  else localStorage.removeItem(ACTIVE_KEY);
}

export function getActiveProject(): Project | null {
  return getProject(getActiveProjectId());
}
