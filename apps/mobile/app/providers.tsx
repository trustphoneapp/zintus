import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import BottomSheet from "@gorhom/bottom-sheet";
import { useFocusEffect } from "expo-router";
import { listProviders } from "@multipleai/providers";
import type { ProviderId } from "@multipleai/types";
import { ProviderSheet } from "@/components/ProviderSheet";
import { QuotaBar } from "@/components/QuotaBar";
import { deleteApiKey, hasApiKey } from "@/lib/keys";
import { getQuotaSnapshot } from "@/lib/quota";

interface ProviderRowState {
  providerId: ProviderId;
  hasKey: boolean;
  requestsUsed: number;
  tokensUsed: number;
  inCooldown: boolean;
}

export default function ProvidersScreen() {
  const sheetRef = useRef<BottomSheet>(null);
  const [rows, setRows] = useState<ProviderRowState[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>("groq");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const providers = listProviders();
      const next = await Promise.all(
        providers.map(async (provider) => {
          const snapshot = await getQuotaSnapshot(provider.id);
          const keySaved =
            provider.id === "ollama" ? true : await hasApiKey(provider.id);
          return {
            providerId: provider.id,
            hasKey: keySaved,
            requestsUsed: snapshot.requestsUsed,
            tokensUsed: snapshot.tokensUsed,
            inCooldown: snapshot.inCooldown,
          };
        }),
      );
      setRows(next);
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
  ) as Record<ProviderId, ProviderRowState | undefined>;

  return (
    <View className="flex-1 bg-surface">
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <Text className="text-sm text-muted">
          API keys are stored in expo-secure-store. Open the sheet to add or
          update a key.
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
                <View className="mb-3 flex-row items-center justify-between">
                  <View>
                    <Text className="text-lg font-semibold text-ink">
                      {provider.name}
                    </Text>
                    <Text className="text-xs text-muted">
                      {row?.hasKey ? "Key configured" : "No key"}
                      {row?.inCooldown ? " · cooldown" : ""}
                    </Text>
                  </View>
                  <View
                    className="h-3 w-3 rounded-full"
                    style={{ backgroundColor: provider.color }}
                  />
                </View>

                {row ? (
                  <QuotaBar
                    providerId={provider.id}
                    requestsToday={row.requestsUsed}
                    tokensToday={row.tokensUsed}
                    inCooldown={row.inCooldown}
                  />
                ) : null}

                <View className="mt-3 flex-row gap-2">
                  <Pressable
                    className="flex-1 items-center rounded-lg bg-accent py-2.5"
                    onPress={() => {
                      setSelectedProvider(provider.id);
                      sheetRef.current?.expand();
                    }}
                  >
                    <Text className="font-semibold text-slate-950">
                      {row?.hasKey ? "Update key" : "Add key"}
                    </Text>
                  </Pressable>
                  {row?.hasKey && provider.id !== "ollama" ? (
                    <Pressable
                      className="items-center rounded-lg border border-slate-600 px-4 py-2.5"
                      onPress={async () => {
                        await deleteApiKey(provider.id);
                        await refresh();
                      }}
                    >
                      <Text className="text-ink">Remove</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>
            );
          })
        )}
      </ScrollView>

      <ProviderSheet
        sheetRef={sheetRef}
        selectedProvider={selectedProvider}
        onSelectProvider={setSelectedProvider}
        onSaved={refresh}
      />
    </View>
  );
}
