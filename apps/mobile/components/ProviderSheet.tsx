import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetTextInput,
  BottomSheetView,
} from "@gorhom/bottom-sheet";
import { listProviders } from "@zintus/providers";
import type { ProviderId } from "@zintus/types";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { getApiKey } from "@/lib/keys";
import { getQuotaSnapshot } from "@/lib/quota";
import { validateProviderKey } from "@/lib/validate";
import { notifyStreamError } from "@/lib/notifications";
import {
  pushKeyToGateway,
  removeKeyFromGateway,
} from "@/lib/gateway-key-push";

interface ProviderSheetProps {
  sheetRef: React.RefObject<BottomSheet | null>;
  selectedProvider: ProviderId;
  onSelectProvider: (providerId: ProviderId) => void;
  onSaved?: () => void | Promise<void>;
}

export function ProviderSheet({
  sheetRef,
  selectedProvider,
  onSelectProvider,
  onSaved,
}: ProviderSheetProps) {
  const providers = useMemo(() => listProviders(), []);
  const snapPoints = useMemo(() => ["55%", "85%"], []);
  const [apiKey, setApiKeyInput] = useState("");
  const [quotaLabel, setQuotaLabel] = useState("");
  const [validating, setValidating] = useState(false);

  const renderBackdrop = useCallback(
    (props: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        pressBehavior="close"
      />
    ),
    [],
  );

  async function refreshQuota(providerId: ProviderId) {
    const snapshot = await getQuotaSnapshot(providerId);
    const parts: string[] = [];

    if (snapshot.limits.requestsPerDay != null) {
      parts.push(
        `${snapshot.requestsUsed}/${snapshot.limits.requestsPerDay} requests`,
      );
    }

    if (snapshot.limits.tokensPerDay != null) {
      parts.push(
        `${snapshot.tokensUsed}/${snapshot.limits.tokensPerDay} tokens`,
      );
    }

    setQuotaLabel(parts.length > 0 ? parts.join(" · ") : "No daily cap");
  }

  async function handleOpen() {
    const saved = await getApiKey(selectedProvider);
    setApiKeyInput(saved ?? "");
    await refreshQuota(selectedProvider);
  }

  async function saveKey() {
    setValidating(true);
    try {
      const trimmed = apiKey.trim();
      if (!trimmed) {
        // Empty key → remove everywhere (gateway + local).
        await removeKeyFromGateway(selectedProvider);
        sheetRef.current?.close();
        await onSaved?.();
        return;
      }

      const valid = await validateProviderKey(selectedProvider, trimmed);
      if (!valid) {
        await notifyStreamError(
          `${selectedProvider} key validation failed. Check the key or validate URL.`,
        );
        return;
      }

      // Encrypt-and-push to the gateway over the relay; this also mirrors the
      // key into local secure storage on success.
      const result = await pushKeyToGateway(selectedProvider, trimmed);
      if (!result.success) {
        await notifyStreamError(result.error ?? "Failed to push key to gateway");
        return;
      }

      sheetRef.current?.close();
      await onSaved?.();
    } finally {
      setValidating(false);
    }
  }

  return (
    <BottomSheet
      ref={sheetRef}
      index={-1}
      snapPoints={snapPoints}
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      backgroundStyle={{ backgroundColor: "#111827" }}
      handleIndicatorStyle={{ backgroundColor: "#4b5563" }}
      onChange={(index: number) => {
        if (index >= 0) {
          void handleOpen();
        }
      }}
    >
      <BottomSheetView className="flex-1 px-4 pb-8">
        <Text className="mb-1 text-lg font-bold text-ink">Provider</Text>
        <Text className="mb-4 text-sm text-muted">{quotaLabel}</Text>

        <View className="mb-4 gap-2">
          {providers.map((provider) => {
            const active = provider.id === selectedProvider;
            return (
              <Pressable
                key={provider.id}
                className={`rounded-xl px-3 py-3 ${
                  active ? "border border-accent bg-accent/20" : "bg-panel"
                }`}
                onPress={() => {
                  onSelectProvider(provider.id);
                  void refreshQuota(provider.id);
                  void getApiKey(provider.id).then((saved) =>
                    setApiKeyInput(saved ?? ""),
                  );
                }}
              >
                <Text
                  className={`font-semibold capitalize ${
                    active ? "text-accent" : "text-ink"
                  }`}
                >
                  {provider.name}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Text className="mb-2 text-sm text-muted">API key (secure store)</Text>
        <BottomSheetTextInput
          className="mb-4 rounded-xl bg-panel px-3 py-3 text-ink"
          value={apiKey}
          onChangeText={setApiKeyInput}
          placeholder="sk-..."
          placeholderTextColor="#6b7280"
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Pressable
          className="items-center rounded-xl bg-accent py-3"
          disabled={validating}
          onPress={() => void saveKey()}
        >
          {validating ? (
            <ActivityIndicator color="#041018" />
          ) : (
            <Text className="font-bold text-surface">Save & validate</Text>
          )}
        </Pressable>
      </BottomSheetView>
    </BottomSheet>
  );
}
