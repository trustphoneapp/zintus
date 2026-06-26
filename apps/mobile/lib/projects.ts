import { createMMKV } from "react-native-mmkv";
import type { ProviderId, RoutingStrategy } from "@zintus/types";

/**
 * Projects / workspaces — a Claude-style layer that gives a set of chats shared
 * instructions and routing defaults. Stored locally (MMKV) as a small JSON list;
 * threads reference a project via lib/history's `project_id`. The project's
 * `instructions` are injected as a system message when chatting in it, and its
 * defaults (provider / strategy / private) seed each new chat.
 */

const storage = createMMKV({ id: "zintus.projects" });
const KEY = "projects.v1";

export interface Project {
  id: string;
  name: string;
  /** Shared context, sent as a system message for every chat in the project. */
  instructions: string;
  defaultProvider: ProviderId | null;
  strategy: RoutingStrategy | null;
  /** Default Private Mode (block training) for chats in this project. */
  privateDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

function readAll(): Project[] {
  const raw = storage.getString(KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as Project[];
  } catch {
    return [];
  }
}

function writeAll(projects: Project[]): void {
  storage.set(KEY, JSON.stringify(projects));
}

function newId(): string {
  return `prj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function listProjects(): Project[] {
  return readAll().sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getProject(id: string): Project | null {
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

export function updateProject(id: string, patch: Partial<ProjectInput>): void {
  writeAll(
    readAll().map((p) =>
      p.id === id
        ? {
            ...p,
            ...("name" in patch ? { name: patch.name!.trim() || p.name } : {}),
            ...("instructions" in patch
              ? { instructions: patch.instructions ?? "" }
              : {}),
            ...("defaultProvider" in patch
              ? { defaultProvider: patch.defaultProvider ?? null }
              : {}),
            ...("strategy" in patch ? { strategy: patch.strategy ?? null } : {}),
            ...("privateDefault" in patch
              ? { privateDefault: patch.privateDefault ?? false }
              : {}),
            updatedAt: Date.now(),
          }
        : p,
    ),
  );
}

export function deleteProject(id: string): void {
  writeAll(readAll().filter((p) => p.id !== id));
}
