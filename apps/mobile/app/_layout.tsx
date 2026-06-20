import "../global.css";

import { useEffect } from "react";
import { Linking } from "react-native";
import { Tabs } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Ionicons } from "@expo/vector-icons";
import { ensureNotificationPermissions } from "@/lib/notifications";
import { COLORS } from "@/lib/theme";
import * as WebBrowser from "expo-web-browser";

export default function RootLayout() {
  useEffect(() => {
    void ensureNotificationPermissions();
    // Complete any in-progress expo-web-browser auth sessions.
    void WebBrowser.warmUpAsync();
    return () => { void WebBrowser.coolDownAsync(); };
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
          name="usage"
          options={{
            title: "Usage",
            tabBarIcon: ({ color, size }) => (
              <Ionicons name="stats-chart" size={size} color={color} />
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
