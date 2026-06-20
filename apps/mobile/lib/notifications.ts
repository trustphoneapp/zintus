import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { listProviders } from "@zintus/providers";
import type { ProviderId } from "@zintus/types";
import { QUOTA_WARNING_THRESHOLD } from "./limits";
import { remainingRatio } from "./quota";

const warnedProviders = new Set<ProviderId>();

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export async function ensureNotificationPermissions(): Promise<boolean> {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("quota", {
      name: "Quota alerts",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const current = await Notifications.getPermissionsAsync();
  if (current.granted) {
    return true;
  }

  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted;
}

export async function checkQuotaWarnings(now = Date.now()): Promise<void> {
  const allowed = await ensureNotificationPermissions();
  if (!allowed) {
    return;
  }

  for (const provider of listProviders()) {
    const ratio = await remainingRatio(provider.id, now);
    if (ratio > QUOTA_WARNING_THRESHOLD) {
      warnedProviders.delete(provider.id);
      continue;
    }

    if (warnedProviders.has(provider.id)) {
      continue;
    }

    warnedProviders.add(provider.id);
    const percent = Math.round(ratio * 100);
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `${provider.name} quota low`,
        body: `About ${percent}% of today's quota remains.`,
        data: { providerId: provider.id },
      },
      trigger: null,
    });
  }
}

export async function notifyQuotaExhausted(
  providerId: ProviderId,
): Promise<void> {
  const allowed = await ensureNotificationPermissions();
  if (!allowed) {
    return;
  }

  await Notifications.scheduleNotificationAsync({
    content: {
      title: "Provider quota reached",
      body: `${providerId} is out of quota for today.`,
      data: { providerId },
    },
    trigger: null,
  });
}

export async function notifyStreamError(message: string): Promise<void> {
  const allowed = await ensureNotificationPermissions();
  if (!allowed) {
    return;
  }

  await Notifications.scheduleNotificationAsync({
    content: {
      title: "Chat request failed",
      body: message,
    },
    trigger: null,
  });
}
