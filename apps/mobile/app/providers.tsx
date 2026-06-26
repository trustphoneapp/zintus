import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import BottomSheet from "@gorhom/bottom-sheet";
import { useFocusEffect, useRouter } from "expo-router";
import { listProviders } from "@zintus/providers";
import { PROVIDER_METADATA } from "@zintus/providers";
import type { ProviderId } from "@zintus/types";
import { ProviderSheet } from "@/components/ProviderSheet";
import { QuotaBar } from "@/components/QuotaBar";
import { loadSelectedProvider, saveSelectedProvider } from "@/lib/config";
import { hasApiKey } from "@/lib/keys";
import { getQuotaSnapshot } from "@/lib/quota";
import {
  fetchGatewayHealth,
  type GatewayProviderStatus,
} from "@/lib/gateway";
import {
  fetchSessionStatus,
  type LocalRuntimes,
} from "@/lib/cloud";
import {
  removeKeyFromGateway,
  resolveSessionId,
} from "@/lib/gateway-key-push";
import { fetchRouteOptions, type RouteOptions } from "@/lib/route-options";
import {
  priceLabel,
  testStoredKey,
  type KeyTestResult,
} from "@/lib/provider-intel";

interface ProviderRowState {
  providerId: ProviderId;
  hasKey: boolean;
  requestsUsed: number;
  tokensUsed: number;
  inCooldown: boolean;
}

export default function ProvidersScreen() {
  const router = useRouter();
  const sheetRef = useRef<BottomSheet>(null);
  const [rows, setRows] = useState<ProviderRowState[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>(
    loadSelectedProvider(),
  );
  const [loading, setLoading] = useState(true);
  const [gatewayStatus, setGatewayStatus] = useState<Record<
    ProviderId,
    GatewayProviderStatus | undefined
  > | null>(null);
  // null = gateway offline / no status → hide "On your system" section entirely.
  const [localRuntimes, setLocalRuntimes] = useState<LocalRuntimes | null>(null);
  const [testResults, setTestResults] = useState<
    Record<string, KeyTestResult | "testing" | undefined>
  >({});
  const [recommendation, setRecommendation] = useState<RouteOptions | null>(null);

  async function runTest(providerId: ProviderId) {
    setTestResults((prev) => ({ ...prev, [providerId]: "testing" }));
    const result = await testStoredKey(providerId);
    setTestResults((prev) => ({ ...prev, [providerId]: result }));
  }

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const providers = listProviders();
      const [next, health] = await Promise.all([
        Promise.all(
          providers.map(async (provider) => {
            const snapshot = await getQuotaSnapshot(provider.id);
            const keySaved =
              provider.id === "ollama" || provider.id === "lmstudio"
                ? true
                : await hasApiKey(provider.id);
            return {
              providerId: provider.id,
              hasKey: keySaved,
              requestsUsed: snapshot.requestsUsed,
              tokensUsed: snapshot.tokensUsed,
              inCooldown: snapshot.inCooldown,
            };
          }),
        ),
        fetchGatewayHealth(),
      ]);
      setRows(next);
      setGatewayStatus(
        health
          ? (Object.fromEntries(
              health.providers.map((status) => [status.id, status]),
            ) as Record<ProviderId, GatewayProviderStatus | undefined>)
          : null,
      );

      // Local runtimes are reported by the cloud gateway status (not the local
      // health endpoint). Resolve the current session and read localRuntimes.
      try {
        const sessionId = await resolveSessionId();
        const status = sessionId
          ? await fetchSessionStatus(sessionId)
          : null;
        setLocalRuntimes(status?.localRuntimes ?? null);
      } catch {
        setLocalRuntimes(null);
      }

      // Recommendation for the user's selected provider (cheapest/local/wait).
      setRecommendation(await fetchRouteOptions(loadSelectedProvider()));
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

        {recommendation ? (
          <View className="rounded-xl border border-slate-700 bg-panel p-3">
            <Text className="text-xs font-semibold text-accent-bright">
              Recommended now
            </Text>
            <Text className="mt-0.5 text-xs text-muted">
              {recommendation.reason}
            </Text>
            {recommendation.alternatives.length > 0 ? (
              <Text className="mt-1 text-[10px] text-muted">
                Cheapest alternative: {recommendation.alternatives[0].provider} (~$
                {recommendation.alternatives[0].estInputPer1M} in /$
                {recommendation.alternatives[0].estOutputPer1M} out per 1M)
              </Text>
            ) : null}
          </View>
        ) : null}

        {loading ? (
          <ActivityIndicator color="#f4f6f8" />
        ) : (
          listProviders()
            .filter(
              (provider) =>
                provider.id !== "ollama" && provider.id !== "lmstudio",
            )
            .map((provider) => {
            const row = rowMap[provider.id];
            const live = gatewayStatus?.[provider.id];
            const meta = PROVIDER_METADATA[provider.id];
            return (
              <View
                key={provider.id}
                className="rounded-xl border border-slate-800 bg-panel p-4"
              >
                <View className="mb-3 flex-row items-center justify-between">
                  <View className="flex-1 pr-3">
                    <Text className="text-lg font-semibold text-ink">
                      {meta?.name ?? provider.name}
                    </Text>
                    {meta ? (
                      <Text className="text-xs text-muted">
                        {meta.description}
                      </Text>
                    ) : null}
                    <Text className="text-xs text-muted">
                      {row?.hasKey ? "Key configured" : "No key"}
                      {row?.inCooldown ? " · cooldown" : ""}
                    </Text>
                    {meta ? (
                      <View className="mt-1 flex-row flex-wrap gap-1">
                        <Text className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-muted">
                          {meta.freeTier}
                        </Text>
                        <Text
                          className={`rounded px-1.5 py-0.5 text-[10px] ${
                            meta.trainsOnData
                              ? "bg-amber-500/15 text-amber-500"
                              : "bg-emerald-500/15 text-emerald-400"
                          }`}
                        >
                          {meta.trainsOnData
                            ? "May train on data"
                            : "No training on data"}
                        </Text>
                      </View>
                    ) : null}
                    {(() => {
                      const price = priceLabel(
                        provider.id,
                        provider.defaultModel,
                      );
                      return price ? (
                        <Text className="mt-1 text-[10px] text-muted">
                          {price}
                        </Text>
                      ) : null;
                    })()}
                    {live ? (
                      <Text
                        className={`text-xs ${
                          live.available && !live.inCooldown
                            ? "text-accent-bright"
                            : "text-amber-500"
                        }`}
                      >
                        Gateway:{" "}
                        {live.inCooldown
                          ? "cooldown"
                          : live.available
                            ? "available"
                            : "unavailable"}
                        {live.quotaLimit != null
                          ? ` · ${live.quotaUsed ?? 0}/${live.quotaLimit}`
                          : ""}
                      </Text>
                    ) : null}
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
                      saveSelectedProvider(provider.id);
                      sheetRef.current?.expand();
                    }}
                  >
                    <Text className="font-semibold text-slate-950">
                      {row?.hasKey ? "Update key" : "Add key"}
                    </Text>
                  </Pressable>
                  {row?.hasKey ? (
                    <Pressable
                      className="items-center rounded-lg border border-slate-600 px-3 py-2.5"
                      onPress={() => void runTest(provider.id)}
                    >
                      <Text className="text-ink">
                        {testResults[provider.id] === "testing" ? "…" : "Test"}
                      </Text>
                    </Pressable>
                  ) : null}
                  {row?.hasKey ? (
                    <Pressable
                      className="items-center rounded-lg border border-slate-600 px-4 py-2.5"
                      onPress={async () => {
                        await removeKeyFromGateway(provider.id);
                        await refresh();
                      }}
                    >
                      <Text className="text-ink">Remove</Text>
                    </Pressable>
                  ) : null}
                </View>
                {testResults[provider.id] &&
                testResults[provider.id] !== "testing" ? (
                  <Text
                    className={`mt-2 text-xs ${
                      testResults[provider.id] === "ok"
                        ? "text-emerald-400"
                        : "text-red-400"
                    }`}
                  >
                    {testResults[provider.id] === "ok"
                      ? "Key valid ✓"
                      : testResults[provider.id] === "bad"
                        ? "Key invalid ✗"
                        : "No key saved"}
                  </Text>
                ) : null}
              </View>
            );
          })
        )}

        {/* "On your system" — driven by the gateway's reported localRuntimes.
            Hidden entirely when the gateway is offline / no status. */}
        {!loading && localRuntimes ? (
          <View className="mt-4 gap-2">
            <Text className="text-sm font-semibold text-ink">
              On your system
            </Text>
            <Text className="text-xs text-muted">
              Local runtimes detected on your gateway machine. Prompts never
              leave your device.
            </Text>
            {(["ollama", "lmstudio"] as const).map((id) => {
              const meta = PROVIDER_METADATA[id];
              const runtime = localRuntimes[id];
              const detected = runtime?.detected ?? false;
              const modelCount = runtime?.models?.length ?? 0;
              return (
                <View
                  key={id}
                  className="rounded-xl border border-slate-800 bg-panel p-4"
                >
                  <View className="flex-row items-center justify-between">
                    <View className="flex-1 pr-3">
                      <Text className="text-base font-semibold text-ink">
                        {meta.name}
                      </Text>
                      {detected ? (
                        <Text className="text-xs text-emerald-400">
                          {`● detected${
                            modelCount > 0 ? ` · ${modelCount} models` : ""
                          }`}
                        </Text>
                      ) : (
                        <Pressable
                          onPress={() => void Linking.openURL(meta.keyUrl)}
                        >
                          <Text className="text-xs text-muted">
                            {`○ not detected · `}
                            <Text className="text-accent-bright underline">
                              install
                            </Text>
                          </Text>
                        </Pressable>
                      )}
                    </View>
                    <View
                      className="h-3 w-3 rounded-full"
                      style={{ backgroundColor: meta.color }}
                    />
                  </View>
                  {detected ? (
                    <Pressable
                      className="mt-3 items-center rounded-lg bg-accent py-2"
                      onPress={() => {
                        setSelectedProvider(id);
                        saveSelectedProvider(id);
                        router.push("/");
                      }}
                    >
                      <Text className="font-semibold text-slate-950">
                        Use {meta.name} (on-device)
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              );
            })}
          </View>
        ) : null}
      </ScrollView>

      <ProviderSheet
        sheetRef={sheetRef}
        selectedProvider={selectedProvider}
        onSelectProvider={(providerId) => {
          setSelectedProvider(providerId);
          saveSelectedProvider(providerId);
        }}
        onSaved={refresh}
      />
    </View>
  );
}
