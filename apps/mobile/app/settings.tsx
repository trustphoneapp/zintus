import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useFocusEffect } from "expo-router";
import type { RoutingStrategy } from "@zintus/types";
import {
  getDefaultGatewayUrl,
  getGatewayUrl,
  getSavedGatewayUrl,
  setGatewayUrl as persistGatewayUrl,
} from "@/lib/gateway-url";
import {
  ROUTING_STRATEGIES,
  loadConfig,
  loadNotificationsEnabled,
  saveConfig,
  saveNotificationsEnabled,
} from "@/lib/config";
import { fetchGatewayHealth, type GatewaySavings } from "@/lib/gateway";
import { requestNotificationOptIn } from "@/lib/notifications";
import { COLORS } from "@/lib/theme";

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export default function SettingsScreen() {
  const [gatewayInput, setGatewayInput] = useState("");
  const [effectiveUrl, setEffectiveUrl] = useState("");
  const [savedNote, setSavedNote] = useState(false);
  const [strategy, setStrategy] = useState<RoutingStrategy>("fastest");
  const [savings, setSavings] = useState<GatewaySavings | null>(null);
  const [notificationsOn, setNotificationsOn] = useState(false);
  const [notifNote, setNotifNote] = useState<string | null>(null);

  useEffect(() => {
    setGatewayInput(getSavedGatewayUrl() ?? "");
    setEffectiveUrl(getGatewayUrl());
    setStrategy(loadConfig().routingStrategy);
    setNotificationsOn(loadNotificationsEnabled());
  }, []);

  async function toggleNotifications() {
    if (notificationsOn) {
      saveNotificationsEnabled(false);
      setNotificationsOn(false);
      setNotifNote("Alerts off.");
      return;
    }
    // Turning ON: request the OS permission in-context (this user action).
    const granted = await requestNotificationOptIn();
    if (granted) {
      saveNotificationsEnabled(true);
      setNotificationsOn(true);
      setNotifNote("Alerts on.");
    } else {
      saveNotificationsEnabled(false);
      setNotificationsOn(false);
      setNotifNote(
        "Notification permission was denied. Enable it in your device Settings, then try again.",
      );
    }
  }

  function saveGateway(value: string) {
    persistGatewayUrl(value);
    setGatewayInput(getSavedGatewayUrl() ?? "");
    setEffectiveUrl(getGatewayUrl());
    setSavedNote(true);
  }

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
          <Text className="mb-1 text-lg font-semibold text-ink">Gateway</Text>
          <Text className="mb-3 text-xs text-muted">
            URL of the machine running `zintus serve`. On a phone or emulator,
            `localhost` means the device itself — use your computer&apos;s LAN IP
            (e.g. http://192.168.1.x:8788). Leave blank to auto-detect.
          </Text>
          <TextInput
            value={gatewayInput}
            onChangeText={(text) => {
              setGatewayInput(text);
              setSavedNote(false);
            }}
            placeholder={getDefaultGatewayUrl()}
            placeholderTextColor={COLORS.muted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            className="rounded-xl bg-surface px-3 py-3 font-mono text-sm text-ink"
          />
          <View className="mt-3 flex-row gap-2">
            <Pressable
              className="flex-1 rounded-xl border border-accent bg-accent/20 px-3 py-3"
              onPress={() => saveGateway(gatewayInput)}
            >
              <Text className="text-center font-semibold text-accent-bright">
                Save
              </Text>
            </Pressable>
            <Pressable
              className="rounded-xl border border-slate-800 bg-surface px-3 py-3"
              onPress={() => saveGateway("")}
            >
              <Text className="text-center font-semibold text-ink">
                Use default
              </Text>
            </Pressable>
          </View>
          <Text className="mt-3 text-xs text-muted">
            {savedNote ? "Saved. " : ""}Using: {effectiveUrl}
          </Text>
        </View>

        <View className="mt-4 rounded-xl border border-slate-800 bg-panel p-4">
          <Text className="mb-1 text-lg font-semibold text-ink">
            Notifications
          </Text>
          <Text className="mb-3 text-xs text-muted">
            Local alerts when a provider&apos;s free-tier quota runs low or a
            request fails. Off by default — turning this on asks for the OS
            notification permission. Nothing is sent to any server.
          </Text>
          <Pressable
            className={`flex-row items-center justify-between rounded-xl border px-3 py-3 ${
              notificationsOn
                ? "border-accent bg-accent/20"
                : "border-slate-800 bg-surface"
            }`}
            onPress={toggleNotifications}
          >
            <Text className="font-semibold text-ink">Quota &amp; error alerts</Text>
            <Text
              className={`font-semibold ${
                notificationsOn ? "text-accent-bright" : "text-muted"
              }`}
            >
              {notificationsOn ? "On" : "Off"}
            </Text>
          </Pressable>
          {notifNote ? (
            <Text className="mt-3 text-xs text-muted">{notifNote}</Text>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}
