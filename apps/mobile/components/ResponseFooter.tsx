import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ProviderId } from "@zintus/types";

import type { ResponseMeta } from "@/lib/chat";
import {
  ROUTE_OPTION_META,
  isQuotaLow,
  type RouteOption,
  type RouteOptions,
} from "@/lib/route-options";
import { COLORS } from "@/lib/theme";

interface ResponseFooterProps {
  providerId?: ProviderId;
  model?: string;
  meta?: ResponseMeta;
  /** Gateway quota decision for this provider; null/undefined hides the strip. */
  routeOptions?: RouteOptions | null;
  onAction?: (action: RouteOption) => void;
}

/** Reduction percentage, computed exactly from saved/original when possible. */
function reductionPct(meta: ResponseMeta): number | null {
  if (
    meta.tokensSaved != null &&
    meta.originalTokens != null &&
    meta.originalTokens > 0
  ) {
    return Math.round((meta.tokensSaved / meta.originalTokens) * 100);
  }
  if (meta.compressionRatio != null) {
    return Math.round((1 - meta.compressionRatio) * 100);
  }
  return null;
}

function formatUsd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `~$${value.toFixed(4)}`;
  return `~$${value.toFixed(2)}`;
}

function quotaColor(remaining: number | null): string {
  if (remaining == null) return COLORS.muted;
  if (remaining <= 0.1) return COLORS.error;
  if (remaining <= 0.3) return COLORS.warn;
  return COLORS.good;
}

/**
 * The Zintus "response intelligence" footer — shown after EVERY assistant
 * answer. It makes Zintus's moat visible IN the chat (not buried in settings):
 * which provider/model served, how much Tokzen compression saved, the estimated
 * cost saved, remaining free-tier quota, why the route was chosen, and — when
 * quota is low — the BYOK-only actions to take. Everything here is derived from
 * gateway response headers + the local decision API; no keys or prompt content.
 */
function ResponseFooterImpl({
  providerId,
  model,
  meta,
  routeOptions,
  onAction,
}: ResponseFooterProps) {
  const reduction = meta ? reductionPct(meta) : null;
  const showSavings =
    meta != null && reduction != null && (meta.tokensSaved ?? 0) > 0;
  const showActions =
    routeOptions != null && isQuotaLow(routeOptions) && onAction != null;

  return (
    <View style={styles.container}>
      <View style={styles.attributionRow}>
        {providerId ? (
          <Text style={styles.attribution}>
            {providerId}
            {model ? ` · ${model}` : ""}
          </Text>
        ) : (
          <Text style={styles.attribution}>routed</Text>
        )}
        {meta?.cacheHit === "hit" ? (
          <View style={[styles.tag, styles.cacheTag]}>
            <Text style={styles.cacheTagText}>cache hit</Text>
          </View>
        ) : null}
        {meta != null && (meta.failoverCount ?? 0) > 0 ? (
          <View style={[styles.tag, styles.failoverTag]}>
            <Text style={styles.failoverTagText}>
              failover ×{meta.failoverCount}
            </Text>
          </View>
        ) : null}
      </View>

      {meta && (meta.routingStrategy || meta.latencyMs != null) ? (
        <Text style={styles.detailLine}>
          {meta.routingStrategy ? `via ${meta.routingStrategy}` : ""}
          {meta.routingStrategy && meta.latencyMs != null ? " · " : ""}
          {meta.latencyMs != null ? `${meta.latencyMs} ms` : ""}
          {meta.outputTokens != null ? ` · ${meta.outputTokens} out tok` : ""}
        </Text>
      ) : null}

      {/* The moat: Tokzen compression savings for this turn. */}
      {showSavings && meta ? (
        <View style={styles.savingsRow}>
          <View style={styles.savingsPill}>
            <Text style={styles.savingsPillText}>Tokzen −{reduction}%</Text>
          </View>
          <Text style={styles.savingsDetail}>
            {meta.originalTokens?.toLocaleString()} →{" "}
            {meta.compressedTokens?.toLocaleString()} tok · saved{" "}
            {meta.tokensSaved?.toLocaleString()}
            {meta.costSavedUsd != null
              ? ` · ${formatUsd(meta.costSavedUsd)}`
              : ""}
          </Text>
        </View>
      ) : (
        <Text style={styles.noSavings}>
          No compression needed on this turn.
        </Text>
      )}

      {meta?.savedVsBaselineUsd != null && meta.savedVsBaselineUsd > 0 ? (
        <Text style={styles.baselineText}>
          ≈ {formatUsd(meta.savedVsBaselineUsd)} cheaper than Claude Sonnet for
          this turn
        </Text>
      ) : null}

      {/* Quota remaining + route reason, from the gateway decision API. */}
      {routeOptions ? (
        <View style={styles.quotaBlock}>
          <View style={styles.quotaRow}>
            <View
              style={[
                styles.quotaDot,
                { backgroundColor: quotaColor(routeOptions.quotaRemaining) },
              ]}
            />
            <Text style={styles.quotaText}>
              {routeOptions.quotaRemaining != null
                ? `${Math.round(routeOptions.quotaRemaining * 100)}% free-tier quota left`
                : "Quota unknown"}
              {routeOptions.resetIn != null
                ? ` · resets ~${Math.ceil(routeOptions.resetIn / 60)}m`
                : ""}
            </Text>
          </View>
          {routeOptions.reason ? (
            <Text style={styles.reasonText}>{routeOptions.reason}</Text>
          ) : null}
        </View>
      ) : null}

      {/* Low-quota actions — BYOK only (no paid overflow, ever). */}
      {showActions ? (
        <View style={styles.actionsRow}>
          {routeOptions!.options.map((option) => {
            const isBest = option === routeOptions!.best;
            return (
              <Pressable
                key={option}
                onPress={() => onAction?.(option)}
                style={({ pressed }) => [
                  styles.actionChip,
                  isBest && styles.actionChipBest,
                  pressed && styles.pressed,
                ]}
              >
                <Text
                  style={[
                    styles.actionChipText,
                    isBest && styles.actionChipTextBest,
                  ]}
                >
                  {ROUTE_OPTION_META[option].label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

export const ResponseFooter = memo(ResponseFooterImpl);

const styles = StyleSheet.create({
  container: {
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
    gap: 6,
  },
  attributionRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  attribution: { color: COLORS.muted, fontSize: 11, fontWeight: "600" },
  detailLine: { color: COLORS.muted, fontSize: 10, marginTop: -2 },
  baselineText: { color: COLORS.good, fontSize: 11, fontWeight: "700" },
  tag: {
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  cacheTag: { backgroundColor: "rgba(52,211,153,0.15)" },
  cacheTagText: { color: COLORS.good, fontSize: 10, fontWeight: "700" },
  failoverTag: { backgroundColor: "rgba(245,158,11,0.15)" },
  failoverTagText: { color: COLORS.warn, fontSize: 10, fontWeight: "700" },
  savingsRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  savingsPill: {
    backgroundColor: "rgba(52,211,153,0.15)",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  savingsPillText: { color: COLORS.good, fontSize: 11, fontWeight: "800" },
  savingsDetail: { color: COLORS.muted, fontSize: 11, flexShrink: 1 },
  noSavings: { color: COLORS.muted, fontSize: 11, fontStyle: "italic" },
  quotaBlock: { gap: 2 },
  quotaRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  quotaDot: { width: 8, height: 8, borderRadius: 4 },
  quotaText: { color: COLORS.ink, fontSize: 11, fontWeight: "600" },
  reasonText: { color: COLORS.muted, fontSize: 11, lineHeight: 15 },
  actionsRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 2 },
  actionChip: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.panel,
  },
  actionChipBest: { borderColor: COLORS.accent, backgroundColor: COLORS.accent },
  actionChipText: { color: COLORS.accentBright, fontSize: 11, fontWeight: "700" },
  actionChipTextBest: { color: COLORS.onAccent },
  pressed: { opacity: 0.7 },
});
