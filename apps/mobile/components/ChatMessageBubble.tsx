import { memo } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { Markdown } from "@/components/Markdown";
import { ResponseFooter } from "@/components/ResponseFooter";
import type { UiMessage } from "@/lib/messages";
import type { RouteOption, RouteOptions } from "@/lib/route-options";
import { COLORS } from "@/lib/theme";

interface ChatMessageBubbleProps {
  message: UiMessage;
  /** Gateway quota decision for this turn's provider (drives footer actions). */
  routeOptions?: RouteOptions | null;
  onCopy: (text: string) => void;
  onCopyCode: (code: string) => void;
  onRetry?: () => void;
  onRegenerate?: () => void;
  onReport?: () => void;
  onRouteAction?: (action: RouteOption) => void;
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

/**
 * One chat turn. Memoized so streaming a token into the LAST bubble doesn't
 * re-render the whole list (battery/jank fix). While streaming we render cheap
 * plain text + a cursor; once finalized we render full Markdown, the action row
 * (copy / retry / regenerate / report), and the Zintus intelligence footer.
 */
function ChatMessageBubbleImpl({
  message,
  routeOptions,
  onCopy,
  onCopyCode,
  onRetry,
  onRegenerate,
  onReport,
  onRouteAction,
}: ChatMessageBubbleProps) {
  const isUser = message.role === "user";
  const done = !message.streaming;
  const hasContent = message.content.trim().length > 0;

  return (
    <View
      style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}
    >
      {message.streaming && !hasContent ? (
        <View style={styles.typingRow}>
          <ActivityIndicator size="small" color={COLORS.accentBright} />
          <Text style={styles.typingText}>Thinking…</Text>
        </View>
      ) : isUser ? (
        <Text style={styles.userText}>{message.content}</Text>
      ) : message.streaming ? (
        // Cheap render mid-stream; Markdown reflow only once on completion.
        <Text style={styles.streamingText}>
          {message.content}
          <Text style={styles.cursor}>▋</Text>
        </Text>
      ) : (
        <Markdown content={message.content} onCopyCode={onCopyCode} />
      )}

      {!isUser && done && hasContent ? (
        <>
          <View style={styles.actionsRow}>
            <Action label="Copy" onPress={() => onCopy(message.content)} />
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
