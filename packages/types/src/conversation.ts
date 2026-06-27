import type { ChatMessage } from "./route.js";

export interface Thread {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ThreadMessage extends Omit<ChatMessage, "content"> {
  /** Stored conversation turns are text-only in v1 (images aren't persisted). */
  content: string;
  id: string;
  threadId: string;
  providerId?: string;
  model?: string;
  traceId?: string;
  createdAt: Date;
}
