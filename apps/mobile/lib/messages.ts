import type { ChatMessage } from "@zintus/types";
import type { ProviderId } from "@zintus/types";

export interface UiMessage extends ChatMessage {
  id: string;
  streaming?: boolean;
}

export function createUserMessage(content: string): UiMessage {
  return {
    id: `${Date.now()}-user`,
    role: "user",
    content: content.trim(),
  };
}

export function createAssistantPlaceholder(): UiMessage {
  return {
    id: `${Date.now()}-assistant`,
    role: "assistant",
    content: "",
    streaming: true,
  };
}

export function toChatMessages(messages: UiMessage[]): ChatMessage[] {
  return messages
    .filter((message) => message.content.trim().length > 0)
    .map(({ role, content }) => ({ role, content }));
}

export function providerLabel(providerId: ProviderId): string {
  return providerId;
}
