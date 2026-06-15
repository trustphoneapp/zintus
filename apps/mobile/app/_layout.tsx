import "../global.css";

import { useEffect } from "react";
import { Tabs } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Ionicons } from "@expo/vector-icons";
import { ensureNotificationPermissions } from "@/lib/notifications";

export default function RootLayout() {
  useEffect(() => {
    void ensureNotificationPermissions();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style="light" />
      <Tabs
        screenOptions={{
          headerStyle: { backgroundColor: "#0b0f14" },
          headerTintColor: "#e8eef5",
          tabBarStyle: {
            backgroundColor: "#0b0f14",
            borderTopColor: "#1f2937",
          },
          tabBarActiveTintColor: "#0ea5e9",
          tabBarInactiveTintColor: "#6b7280",
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
      </Tabs>
    </GestureHandlerRootView>
  );
}
