import { memo } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { textOf } from "@zintus/types";

import { Markdown } from "@/components/Markdown";
import { ResponseFooter } from "@/components/ResponseFooter";
import type { McpToolEvent } from "@/lib/chat";
import type { UiMessage } from "@/lib/messages";
import type { RouteOption, RouteOptions } from "@/lib/route-options";
import { COLORS } from "@/lib/theme";

interface ChatMessageBubbleProps {
  message: UiMessage;
  /** Gateway quota decision for this turn's provider (drives footer actions). */
  routeOptions?: RouteOptions | null;
  /** Artifact-worthy blocks in THIS turn; > 0 shows the Artifacts action. */
  artifactCount?: number;
  onCopy: (text: string) => void;
  onCopyCode: (code: string) => void;
  onRetry?: () => void;
  onRegenerate?: () => void;
  onReport?: () => void;
  onRouteAction?: (action: RouteOption) => void;
  onOpenArtifacts?: () => void;
}

interface ActionProps {
  label: string;
  onPress: () => void;
  tone?: "default" | "danger";
}

function Action({ label, onPress, tone = "default" }: ActionProps) {
  return (
    <Pressable
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [styles.action, pressed && styles.pressed]}
    >
      <Text style={[styles.actionText, tone === "danger" && styles.actionDanger]}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Compact one-line render of a tool's arguments object. */
function formatToolArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args);
  } catch {
    return "{…}";
  }
}

/** Render one MCP tool-loop event as a calm one-line summary (no arg/secret
 *  values — only parameter names / char counts come through the parser). */
function mcpEventLine(event: McpToolEvent): string {
  if (event.kind === "call") {
    const where = event.server ? `${event.server}/` : "";
    const args = event.argsSummary ? `(${event.argsSummary})` : "";
    return `🔧 ${where}${event.tool}${args}`;
  }
  return `${event.ok ? "→ " : "error · "}${event.summary}`;
}

/** Returns a pretty-printed JSON string iff `content` is a JSON object/array,
 *  else null. Lets a `response_format: json_object` turn render as formatted
 *  JSON without ever fabricating structure (mirrors desktop's auto-detect). */
function asStructuredJson(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed || !(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return null;
  }
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

/**
 * One chat turn. Memoized so streaming a token into the LAST bubble doesn't
 * re-render the whole list (battery/jank fix). While streaming we render cheap
 * plain text + a cursor; once finalized we render full Markdown (or formatted
 * JSON for a structured-output turn), the tool/MCP transparency blocks, the
 * action row (copy / retry / regenerate / report / artifacts), the Zintus
 * intelligence footer, and the privacy/memory honesty lines.
 */
function ChatMessageBubbleImpl({
  message,
  routeOptions,
  artifactCount = 0,
  onCopy,
  onCopyCode,
  onRetry,
  onRegenerate,
  onReport,
  onRouteAction,
  onOpenArtifacts,
}: ChatMessageBubbleProps) {
  const isUser = message.role === "user";
  const done = !message.streaming;
  // Multimodal-safe text view of the turn (content may be ContentBlock[]).
  const text = textOf(message.content);
  const hasContent = text.trim().length > 0;
  // The headline "why this provider/model" — the prominent route reason from
  // the gateway's metadata frame. Mirrors web/desktop's top-line pill.
  const routeReason = !isUser ? message.meta?.routeReason : undefined;
  // Render a settled assistant turn that is itself JSON as formatted monospace
  // (the response_format: json_object path), never faking structure.
  const structuredJson =
    !isUser && done && hasContent ? asStructuredJson(text) : null;

  return (
    <View
      style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}
    >
      {routeReason ? (
        <Text style={styles.routeReason} numberOfLines={2}>
          {routeReason}
        </Text>
      ) : null}

      {message.streaming && !hasContent ? (
        <View style={styles.typingRow}>
          <ActivityIndicator size="small" color={COLORS.accentBright} />
          <Text style={styles.typingText}>Thinking…</Text>
        </View>
      ) : isUser ? (
        <Text style={styles.userText}>{text}</Text>
      ) : message.streaming ? (
        // Cheap render mid-stream; Markdown reflow only once on completion.
        <Text style={styles.streamingText}>
          {text}
          <Text style={styles.cursor}>▋</Text>
        </Text>
      ) : structuredJson ? (
        <View style={styles.jsonBlock}>
          <Text style={styles.jsonLabel}>JSON output</Text>
          <Text style={styles.jsonText}>{structuredJson}</Text>
        </View>
      ) : (
        <Markdown content={text} onCopyCode={onCopyCode} />
      )}

      {/* Built-in tool calls the model made this turn, with their locally-
          executed results — full transparency, paired by call id. */}
      {message.toolCalls && message.toolCalls.length > 0 ? (
        <View style={styles.toolBlock}>
          {message.toolCalls.map((call) => {
            const toolResult = message.toolResults?.find(
              (r) => r.toolCallId === call.id,
            );
            return (
              <View key={call.id} style={styles.toolCallRow}>
                <Text style={styles.toolCallName} numberOfLines={2}>
                  {`🔧 ${call.name}(${formatToolArgs(call.arguments)})`}
                </Text>
                {toolResult ? (
                  <Text
                    style={[
                      styles.toolResult,
                      toolResult.isError && styles.toolResultError,
                    ]}
                    numberOfLines={4}
                  >
                    {toolResult.isError ? "error · " : "→ "}
                    {toolResult.content}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}

      {/* Server-side MCP tool-loop activity (display-only; gateway ran them). */}
      {message.mcpEvents && message.mcpEvents.length > 0 ? (
        <View style={styles.toolBlock}>
          {message.mcpEvents.map((event, i) => (
            <Text
              key={`${event.kind}-${event.id}-${i}`}
              style={[
                event.kind === "call" ? styles.toolCallName : styles.toolResult,
                event.kind === "result" && !event.ok && styles.toolResultError,
              ]}
              numberOfLines={3}
            >
              {mcpEventLine(event)}
            </Text>
          ))}
        </View>
      ) : null}

      {!isUser && done && hasContent ? (
        <>
          <View style={styles.actionsRow}>
            <Action label="Copy" onPress={() => onCopy(text)} />
            {artifactCount > 0 && onOpenArtifacts ? (
              <Action
                label={`📄 Artifacts (${artifactCount})`}
                onPress={onOpenArtifacts}
              />
            ) : null}
            {onRetry ? <Action label="Retry" onPress={onRetry} /> : null}
            {onRegenerate ? (
              <Action label="Regenerate" onPress={onRegenerate} />
            ) : null}
            {onReport ? (
              <Action label="Report" onPress={onReport} tone="danger" />
            ) : null}
          </View>
          <ResponseFooter
            providerId={message.providerId}
            model={message.model}
            meta={message.meta}
            routeOptions={routeOptions}
            onAction={onRouteAction}
          />

          {/* Per-response Private-Mode badge — mirrors web/desktop's pill copy +
              honesty exactly. `privacyHonored` is undefined when Private Mode was
              off (no badge), true when a no-training provider served the turn,
              false when a may-train provider was used anyway. Never claim
              "honored" unless the gateway confirmed it. */}
          {message.meta?.privacyHonored != null ? (
            <View
              style={[
                styles.privacyBadge,
                message.meta.privacyHonored
                  ? styles.privacyBadgeHonored
                  : styles.privacyBadgeBroken,
              ]}
            >
              <Text
                style={[
                  styles.privacyBadgeText,
                  {
                    color: message.meta.privacyHonored
                      ? COLORS.good
                      : COLORS.warn,
                  },
                ]}
              >
                {message.meta.privacyHonored
                  ? "✓ Private Mode honored"
                  : "⚠ Private Mode not honored"}
              </Text>
            </View>
          ) : null}

          {/* "Memory used this turn" — stored facts that influenced the answer
              (background data, not instructions). */}
          {message.meta?.memoryUsed && message.meta.memoryUsed.length > 0 ? (
            <Text style={styles.memoryUsed}>
              {message.meta.memoryUsed.length}{" "}
              {message.meta.memoryUsed.length === 1 ? "memory" : "memories"} used
            </Text>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

export const ChatMessageBubble = memo(ChatMessageBubbleImpl);

const styles = StyleSheet.create({
  bubble: { borderRadius: 12, padding: 12, marginBottom: 10, maxWidth: "92%" },
  userBubble: { alignSelf: "flex-end", backgroundColor: COLORS.accent, maxWidth: "85%" },
  assistantBubble: { alignSelf: "flex-start", backgroundColor: COLORS.panel },
  userText: { color: COLORS.onAccent, fontSize: 15, lineHeight: 21 },
  streamingText: { color: COLORS.ink, fontSize: 15, lineHeight: 22 },
  cursor: { color: COLORS.accentBright },
  typingRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  typingText: { color: COLORS.muted, fontSize: 13 },
  routeReason: {
    color: COLORS.accentBright,
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 6,
  },
  jsonBlock: {
    backgroundColor: COLORS.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 10,
  },
  jsonLabel: {
    color: COLORS.muted,
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  jsonText: {
    color: COLORS.ink,
    fontSize: 12,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
  },
  toolBlock: { marginTop: 8, gap: 6 },
  toolCallRow: {
    backgroundColor: COLORS.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 8,
  },
  toolCallName: {
    color: COLORS.accentBright,
    fontSize: 12,
    fontWeight: "600",
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
  },
  toolResult: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 4,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
  },
  toolResultError: { color: COLORS.error },
  privacyBadge: {
    alignSelf: "flex-start",
    marginTop: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
  },
  privacyBadgeHonored: {
    borderColor: COLORS.good,
    backgroundColor: "rgba(52,211,153,0.12)",
  },
  privacyBadgeBroken: {
    borderColor: COLORS.warn,
    backgroundColor: "rgba(245,158,11,0.12)",
  },
  privacyBadgeText: { fontSize: 11, fontWeight: "600" },
  memoryUsed: { color: COLORS.muted, fontSize: 11.5, marginTop: 4 },
  actionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 14,
    marginTop: 10,
  },
  action: {},
  actionText: { color: COLORS.accentBright, fontSize: 12, fontWeight: "700" },
  actionDanger: { color: COLORS.warn },
  pressed: { opacity: 0.6 },
});
