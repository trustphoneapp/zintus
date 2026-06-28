// MUST be imported once, before any crypto usage. Polyfills crypto.getRandomValues
// for Hermes/React Native so @noble (via @zintus/crypto-e2e) has a CSPRNG.
import "react-native-get-random-values";

import "../global.css";

import { useEffect } from "react";
import * as Linking from "expo-linking";
import { Tabs } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Ionicons } from "@expo/vector-icons";
import { ensureNotificationPermissions } from "@/lib/notifications";
import { COLORS } from "@/lib/theme";
import * as WebBrowser from "expo-web-browser";

async function handleDeepLink(url: string | null): Promise<void> {
  if (!url) return;
  try {
    const parsed = Linking.parse(url);
    // zintus://auth?token=...
    if (parsed.hostname === "auth") {
      const { exchangeDeepLinkToken } = await import("@/lib/cloud");
      const token = parsed.queryParams?.["token"] as string | undefined;
      if (token) {
        await exchangeDeepLinkToken(token);
      }
    }
  } catch {
    // Deep-link parse errors are non-fatal
  }
}

export default function RootLayout() {
  useEffect(() => {
    void ensureNotificationPermissions();
    // Complete any in-progress expo-web-browser auth sessions.
    void WebBrowser.warmUpAsync();

    // Cold-start deep link: app opened via URL while not running.
    // 300ms delay ensures the component tree is ready before handling.
    const coldStartTimer = setTimeout(() => {
      void Linking.getInitialURL().then(handleDeepLink);
    }, 300);

    // Warm-start deep link: app already running, URL received.
    const sub = Linking.addEventListener("url", ({ url }) => {
      void handleDeepLink(url);
    });

    return () => {
      clearTimeout(coldStartTimer);
      sub.remove();
      void WebBrowser.coolDownAsync();
    };
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style="light" />
      <Tabs
        screenOptions={{
          headerStyle: { backgroundColor: COLORS.surface },
          headerTintColor: COLORS.ink,
          tabBarStyle: {
            backgroundColor: COLORS.surface,
            borderTopColor: COLORS.border,
          },
          tabBarActiveTintColor: COLORS.accentBright,
          tabBarInactiveTintColor: COLORS.muted,
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: "Chat",
            headerShown: false,
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="chatbubbles" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="providers"
          options={{
            title: "Providers",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="key" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="catalog"
          options={{
            title: "Models",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="cube-outline" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="usage"
          options={{
            title: "Usage",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="stats-chart" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="mcp"
          options={{
            title: "MCP",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="construct-outline" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: "Settings",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="settings-outline" size={size} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="remote"
          options={{
            title: "Remote",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="cloud-outline" size={size} color={color} />
            ),
          }}
        />
      </Tabs>
    </GestureHandlerRootView>
  );
}
