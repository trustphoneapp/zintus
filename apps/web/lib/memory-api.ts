import { GATEWAY_URL, gatewayAuthHeaders } from "./gateway";

/** Where a fact applies (mirrors @zintus/memory's MemoryScope). */
export type MemoryScope = "thread" | "project" | "global";

/** A governance fact as returned by the gateway's /v1/memory routes. Facts are
 *  user-owned BACKGROUND DATA — never instructions. Dates arrive as ISO strings;
 *  lastUsedAt is epoch ms. */
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

async function readMemory(res: Response): Promise<MemoryFact> {
  return ((await res.json()) as { memory: MemoryFact }).memory;
}

/** List facts by scope, optionally narrowed to a thread/project (pinned first). */
export async function listMemory(
  filter: { scope?: MemoryScope; threadId?: string; projectId?: string } = {},
): Promise<MemoryFact[]> {
  const params = new URLSearchParams();
  if (filter.scope) params.set("scope", filter.scope);
  if (filter.threadId) params.set("thread_id", filter.threadId);
  if (filter.projectId) params.set("project_id", filter.projectId);
  const qs = params.toString();
  const res = await fetch(`${GATEWAY_URL}/v1/memory${qs ? `?${qs}` : ""}`, {
    cache: "no-store",
    headers: { ...gatewayAuthHeaders() },
  });
  if (!res.ok) {
    throw new Error(`Failed to load memory (${res.status})`);
  }
  return ((await res.json()) as { memory: MemoryFact[] }).memory;
}

/** Create (or replace by id) a fact. */
export async function createMemory(input: {
  scope?: MemoryScope;
  threadId?: string;
  projectId?: string;
  key: string;
  value: string;
  source?: string;
  pinned?: boolean;
}): Promise<MemoryFact> {
  const res = await fetch(`${GATEWAY_URL}/v1/memory`, {
    method: "POST",
    headers: { "content-type": "application/json", ...gatewayAuthHeaders() },
    body: JSON.stringify({
      scope: input.scope,
      thread_id: input.threadId,
      project_id: input.projectId,
      key: input.key,
      value: input.value,
      source: input.source,
      pinned: input.pinned,
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to save memory (${res.status})`);
  }
  return readMemory(res);
}

/** Edit a fact's text and/or pin state. */
export async function updateMemory(
  id: string,
  patch: { key?: string; value?: string; pinned?: boolean },
): Promise<MemoryFact> {
  const res = await fetch(`${GATEWAY_URL}/v1/memory/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...gatewayAuthHeaders() },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    throw new Error(`Failed to update memory (${res.status})`);
  }
  return readMemory(res);
}

/** Delete a fact by id (idempotent from the UI's perspective). */
export async function deleteMemory(id: string): Promise<void> {
  const res = await fetch(`${GATEWAY_URL}/v1/memory/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { ...gatewayAuthHeaders() },
  });
  if (!res.ok) {
    throw new Error(`Failed to delete memory (${res.status})`);
  }
}
