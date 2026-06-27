import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderId } from "@zintus/types";

/**
 * Projects / workspaces for the CLI — shared instructions + a default provider
 * for a named set of chats, persisted to ~/.zintus/projects.json (mirrors the
 * config store). The active project's instructions are injected as a system
 * message by `zintus chat`. Keyed by name (the CLI identifier).
 */

const DIR = join(homedir(), ".zintus");
const PROJECTS_PATH = join(DIR, "projects.json");

export interface Project {
  name: string;
  instructions: string;
  defaultProvider: ProviderId | null;
  createdAt: number;
}

interface ProjectsFile {
  projects: Project[];
  active: string | null;
}

async function read(): Promise<ProjectsFile> {
  try {
    const parsed = JSON.parse(await readFile(PROJECTS_PATH, "utf-8")) as Partial<ProjectsFile>;
    return { projects: parsed.projects ?? [], active: parsed.active ?? null };
  } catch {
    return { projects: [], active: null };
  }
}

async function write(data: ProjectsFile): Promise<void> {
  await mkdir(DIR, { recursive: true });
  await writeFile(PROJECTS_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export async function listProjects(): Promise<Project[]> {
  return (await read()).projects;
}

export async function getProject(name: string): Promise<Project | null> {
  return (await read()).projects.find((p) => p.name === name) ?? null;
}

export interface CreateProjectInput {
  name: string;
  instructions?: string;
  defaultProvider?: ProviderId | null;
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  const data = await read();
  const project: Project = {
    name: input.name,
    instructions: input.instructions ?? "",
    defaultProvider: input.defaultProvider ?? null,
    createdAt: Date.now(),
  };
  const without = data.projects.filter((p) => p.name !== input.name);
  await write({ ...data, projects: [project, ...without] });
  return project;
}

export async function deleteProject(name: string): Promise<boolean> {
  const data = await read();
  const next = data.projects.filter((p) => p.name !== name);
  const existed = next.length !== data.projects.length;
  await write({
    projects: next,
    active: data.active === name ? null : data.active,
  });
  return existed;
}

export async function getActiveProjectName(): Promise<string | null> {
  return (await read()).active;
}

export async function setActiveProject(name: string | null): Promise<void> {
  const data = await read();
  await write({ ...data, active: name });
}

export async function getActiveProject(): Promise<Project | null> {
  const data = await read();
  if (!data.active) return null;
  return data.projects.find((p) => p.name === data.active) ?? null;
}
