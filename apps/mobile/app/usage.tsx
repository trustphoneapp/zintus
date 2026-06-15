import { useCallback, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { listProviders } from "@multipleai/providers";
import type { ProviderId } from "@multipleai/types";
import { QuotaBar } from "@/components/QuotaBar";
import { getAllQuotaSnapshots } from "@/lib/quota";

interface UsageRow {
  providerId: ProviderId;
  requestsUsed: number;
  tokensUsed: number;
  inCooldown: boolean;
}

export default function UsageScreen() {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<UsageRow[]>([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const snapshots = await getAllQuotaSnapshots();
      setRows(
        snapshots.map((snapshot) => ({
          providerId: snapshot.providerId,
          requestsUsed: snapshot.requestsUsed,
          tokensUsed: snapshot.tokensUsed,
          inCooldown: snapshot.inCooldown,
        })),
      );
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

  return (
    <View className="flex-1 bg-surface">
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <Text className="text-sm text-muted">
          Quota is tracked locally in expo-sqlite. expo-notifications warns
          when remaining quota drops below 20%.
        </Text>

        {loading ? (
          <ActivityIndicator color="#0ea5e9" />
        ) : (
          listProviders().map((provider) => {
            const row = rowMap[provider.id];
            return (
              <View
                key={provider.id}
                className="rounded-xl border border-slate-800 bg-panel p-4"
              >
                <Text className="mb-2 text-lg font-semibold text-ink">
                  {provider.name}
                </Text>
                {row ? (
                  <>
                    <QuotaBar
                      providerId={provider.id}
                      requestsToday={row.requestsUsed}
                      tokensToday={row.tokensUsed}
                      inCooldown={row.inCooldown}
                    />
                    <Text className="mt-2 text-xs text-muted">
                      Tokens today: {row.tokensUsed.toLocaleString()}
                    </Text>
                  </>
                ) : (
                  <Text className="text-sm text-muted">No usage yet</Text>
                )}
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}
