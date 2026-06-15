import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { RoutingStrategy } from "@multipleai/types";
import {
  loadConfig,
  ROUTING_STRATEGIES,
  saveConfig,
} from "@/lib/config";

export default function SettingsScreen() {
  const [strategy, setStrategy] = useState<RoutingStrategy>("fastest");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setStrategy(loadConfig().routingStrategy);
  }, []);

  function persist(next: RoutingStrategy) {
    setStrategy(next);
    saveConfig({ routingStrategy: next });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <View className="flex-1 bg-surface">
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        <Text className="text-sm text-muted">
          Routing preferences are stored locally with react-native-mmkv.
        </Text>

        <View className="rounded-xl border border-slate-800 bg-panel p-4">
          <Text className="mb-3 text-lg font-semibold text-ink">
            Routing strategy
          </Text>
          {ROUTING_STRATEGIES.map((option) => {
            const active = strategy === option.value;
            return (
              <Pressable
                key={option.value}
                className={`mb-2 rounded-xl px-3 py-3 ${
                  active ? "border border-accent bg-accent/20" : "bg-surface"
                }`}
                onPress={() => persist(option.value)}
              >
                <Text
                  className={`font-semibold ${active ? "text-accent" : "text-ink"}`}
                >
                  {option.label}
                </Text>
                <Text className="mt-1 text-sm text-muted">
                  {option.description}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {saved ? (
          <Text className="text-center text-sm text-accent">Settings saved.</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}
