/**
 * Gateway /v1/memory client (desktop). Port of apps/web/lib/memory-api.ts onto
 * the desktop's async gateway resolution. Facts are user-owned BACKGROUND DATA
 * held by the LOCAL gateway (bun:sqlite) — on-device, never used to train.
 */

import { gatewayAuthHeaders, resolveGatewayUrl } from "./gateway";

export type MemoryScope = "thread" | "project" | "global";

export interface MemoryFact {
  id: string;
  threadId: string | null;
  key: string;
  value: string;
  source?: string;
  scope: MemoryScope;
  projectId?: string;
  pinned: boolean;
  lastUsedAt?: number;
  sourceMessageId?: string;
  createdAt: string;
  updatedAt: string;
}

async function gatewayUrlOrThrow(): Promise<string> {
  const url = await resolveGatewayUrl();
  if (!url) throw new Error("Gateway is unavailable — start it with `zintus serve`.");
  return url;
}

export async function listMemory(
  filter: { scope?: MemoryScope; threadId?: string; projectId?: string } = {},
): Promise<MemoryFact[]> {
  const base = await gatewayUrlOrThrow();
  const params = new URLSearchParams();
  if (filter.scope) params.set("scope", filter.scope);
  if (filter.threadId) params.set("thread_id", filter.threadId);
  if (filter.projectId) params.set("project_id", filter.projectId);
  const qs = params.toString();
  const res = await fetch(`${base}/v1/memory${qs ? `?${qs}` : ""}`, {
    cache: "no-store",
    headers: { ...gatewayAuthHeaders() },
  });
  if (!res.ok) throw new Error(`Failed to load memory (${res.status})`);
  return ((await res.json()) as { memory: MemoryFact[] }).memory;
}

export async function updateMemory(
  id: string,
  patch: { key?: string; value?: string; pinned?: boolean },
): Promise<MemoryFact> {
  const base = await gatewayUrlOrThrow();
  const res = await fetch(`${base}/v1/memory/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...gatewayAuthHeaders() },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Failed to update memory (${res.status})`);
  return ((await res.json()) as { memory: MemoryFact }).memory;
}

export async function deleteMemory(id: string): Promise<void> {
  const base = await gatewayUrlOrThrow();
  const res = await fetch(`${base}/v1/memory/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { ...gatewayAuthHeaders() },
  });
  if (!res.ok) throw new Error(`Failed to delete memory (${res.status})`);
}
