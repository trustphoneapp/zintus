import { useCallback, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { listProviders } from "@multipleai/providers";
import type { ProviderId } from "@multipleai/types";
import { getAllQuotaSnapshots, resolveQuotaSource } from "@/lib/quota";
import {
  fetchGatewayHealth,
  type GatewayHealth,
  type GatewayProviderStatus,
} from "@/lib/gateway";

interface UsageRow {
  providerId: ProviderId;
  requestsUsed: number;
  tokensUsed: number;
  inCooldown: boolean;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export default function UsageScreen() {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [health, setHealth] = useState<GatewayHealth | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // Try the gateway first for live quota + savings; always read the local
      // expo-sqlite snapshot too so the screen still works offline.
      const [snapshots, gatewayHealth] = await Promise.all([
        getAllQuotaSnapshots(),
        fetchGatewayHealth(),
      ]);
      setRows(
        snapshots.map((snapshot) => ({
          providerId: snapshot.providerId,
          requestsUsed: snapshot.requestsUsed,
          tokensUsed: snapshot.tokensUsed,
          inCooldown: snapshot.inCooldown,
        })),
      );
      setHealth(gatewayHealth);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  const rowMap = Object.fromEntries(
    rows.map((row) => [row.providerId, row]),
  ) as Record<ProviderId, UsageRow | undefined>;

  const gatewayMap = Object.fromEntries(
    (health?.providers ?? []).map((status) => [status.id, status]),
  ) as Record<ProviderId, GatewayProviderStatus | undefined>;

  const online = health != null;
  const quotaSource = resolveQuotaSource(online);
  const savings = health?.savings ?? null;
  const byProvider = savings ? Object.entries(savings.byProvider) : [];

  return (
    <View className="flex-1 bg-surface">
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {online ? (
          <Text className="text-sm text-muted">
            Live quota and savings from the gateway.
          </Text>
        ) : (
          <View className="rounded-xl border border-amber-500/40 bg-panel p-3">
            <Text className="text-sm font-semibold text-amber-500">
              Gateway offline — quota unknown
            </Text>
            <Text className="mt-1 text-xs text-muted">
              This app routes through the gateway, so live quota isn&apos;t
              available while it&apos;s unreachable. Connect to the gateway to
              see remaining quota and savings.
            </Text>
          </View>
        )}

        {savings ? (
          <View className="rounded-xl border border-accent/40 bg-panel p-4">
            <Text className="text-sm text-muted">Estimated saved</Text>
            <Text className="mt-1 text-3xl font-bold text-accent-bright">
              {formatUsd(savings.estimatedUsdSaved)}
            </Text>
            {savings.note ? (
              <Text className="mt-1 text-xs text-muted">{savings.note}</Text>
            ) : null}
            {byProvider.length > 0 ? (
              <View className="mt-3 gap-1">
                {byProvider.map(([provider, amount]) => (
                  <View
                    key={provider}
                    className="flex-row items-center justify-between"
                  >
                    <Text className="text-sm capitalize text-ink">
                      {provider}
                    </Text>
                    <Text className="text-sm text-muted">
                      {formatUsd(amount)}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        {loading ? (
          <ActivityIndicator color="#f4f6f8" />
        ) : (
          listProviders().map((provider) => {
            const row = rowMap[provider.id];
            const live = gatewayMap[provider.id];
            // Prefer live gateway quota when present; otherwise local snapshot.
            const requestsUsed = live?.quotaUsed ?? row?.requestsUsed ?? 0;
            const requestsLimit = live?.quotaLimit;
            const inCooldown = live?.inCooldown ?? row?.inCooldown ?? false;

            return (
              <View
                key={provider.id}
                className="rounded-xl border border-slate-800 bg-panel p-4"
              >
                <View className="mb-2 flex-row items-center justify-between">
                  <Text className="text-lg font-semibold text-ink">
                    {provider.name}
                  </Text>
                  {live ? (
                    <Text
                      className={`text-xs ${
                        live.available ? "text-muted" : "text-amber-500"
                      }`}
                    >
                      {live.available ? "available" : "unavailable"}
                      {live.hasKey ? "" : " · no key"}
                    </Text>
                  ) : null}
                </View>

                {quotaSource === "gateway" ? (
                  <>
                    <View className="h-2 overflow-hidden rounded-full bg-slate-800">
                      <View
                        className={`h-full rounded-full ${
                          inCooldown ? "bg-amber-500" : "bg-accent"
                        }`}
                        style={{
                          width: `${
                            requestsLimit && requestsLimit > 0
                              ? Math.max(
                                  2,
                                  Math.round(
                                    (1 -
                                      Math.min(
                                        requestsUsed / requestsLimit,
                                        1,
                                      )) *
                                      100,
                                  ),
                                )
                              : 100
                          }%`,
                        }}
                      />
                    </View>
                    <Text className="mt-2 text-xs text-muted">
                      {requestsUsed}
                      {requestsLimit != null ? `/${requestsLimit}` : ""} used
                      {inCooldown ? " · cooldown" : ""}
                    </Text>
                  </>
                ) : (
                  <Text className="text-sm text-muted">
                    Quota unknown — gateway offline
                  </Text>
                )}
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}
