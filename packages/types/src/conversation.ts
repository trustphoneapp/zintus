import type { ChatMessage } from "./route.js";

export interface Thread {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ThreadMessage extends ChatMessage {
  id: string;
  threadId: string;
  providerId?: string;
  model?: string;
  traceId?: string;
  createdAt: Date;
}
