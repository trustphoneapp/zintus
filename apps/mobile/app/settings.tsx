import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import type { RoutingStrategy } from "@zintus/types";
import { getGatewayUrl } from "@/lib/chat";
import {
  ROUTING_STRATEGIES,
  loadConfig,
  saveConfig,
} from "@/lib/config";
import { fetchGatewayHealth, type GatewaySavings } from "@/lib/gateway";

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export default function SettingsScreen() {
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [strategy, setStrategy] = useState<RoutingStrategy>("fastest");
  const [savings, setSavings] = useState<GatewaySavings | null>(null);

  useEffect(() => {
    setGatewayUrl(getGatewayUrl());
    setStrategy(loadConfig().routingStrategy);
  }, []);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void fetchGatewayHealth().then((health) => {
        if (active) {
          setSavings(health?.savings ?? null);
        }
      });
      return () => {
        active = false;
      };
    }, []),
  );

  function selectStrategy(next: RoutingStrategy) {
    setStrategy(next);
    saveConfig({ routingStrategy: next });
  }

  const byProvider = savings ? Object.entries(savings.byProvider) : [];

  return (
    <View className="flex-1 bg-surface">
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        <Text className="text-sm text-muted">
          Chat is routed through the gateway service. Provider key management is
          available in the Providers tab.
        </Text>

        <View className="rounded-xl border border-slate-800 bg-panel p-4">
          <Text className="mb-1 text-lg font-semibold text-ink">
            Routing strategy
          </Text>
          <Text className="mb-3 text-xs text-muted">
            Applied when no specific provider is chosen (Auto). Sent to the
            gateway with each request.
          </Text>
          <View className="gap-2">
            {ROUTING_STRATEGIES.map((option) => {
              const active = option.value === strategy;
              return (
                <Pressable
                  key={option.value}
                  className={`rounded-xl px-3 py-3 ${
                    active
                      ? "border border-accent bg-accent/20"
                      : "border border-slate-800 bg-surface"
                  }`}
                  onPress={() => {
                    selectStrategy(option.value);
                  }}
                >
                  <Text
                    className={`font-semibold ${
                      active ? "text-accent-bright" : "text-ink"
                    }`}
                  >
                    {option.label}
                  </Text>
                  <Text className="mt-1 text-xs text-muted">
                    {option.description}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View className="rounded-xl border border-slate-800 bg-panel p-4">
          <Text className="mb-1 text-lg font-semibold text-ink">
            Estimated saved
          </Text>
          {savings ? (
            <>
              <Text className="text-3xl font-bold text-accent-bright">
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
            </>
          ) : (
            <Text className="text-sm text-muted">
              Gateway unreachable — savings unavailable offline.
            </Text>
          )}
        </View>

        <View className="rounded-xl border border-slate-800 bg-panel p-4">
          <Text className="mb-3 text-lg font-semibold text-ink">Gateway</Text>
          <Text className="rounded-xl bg-surface px-3 py-3 font-mono text-sm text-ink">
            {gatewayUrl}
          </Text>
        </View>
      </ScrollView>
    </View>
  );
}
