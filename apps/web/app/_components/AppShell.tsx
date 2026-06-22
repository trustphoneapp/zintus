"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { fetchGatewayHealth, GATEWAY_URL } from "@/lib/gateway";
import { useAppStore } from "@/lib/app-store";
import { ThemeToggle } from "@/components/marketing/ThemeToggle";
import { Sidebar } from "./Sidebar";
import { GatewayOfflineBanner } from "./GatewayOfflineBanner";

const TITLES: Record<string, string> = {
  "/chat": "Chat",
  "/terminal": "Terminal",
  "/providers": "Providers",
  "/usage": "Usage",
  "/settings": "Settings",
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [checked, setChecked] = useState(false);
  const { gatewayConnected, setGatewayStatus } = useAppStore();

  useEffect(() => {
    let active = true;

    async function refresh() {
      const health = await fetchGatewayHealth();
      if (!active) {
        return;
      }
      setGatewayStatus(
        Boolean(health?.ok),
        health?.providers ?? [],
        health?.savings,
      );
      setChecked(true);
    }

    refresh();
    const interval = window.setInterval(refresh, 3000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [setGatewayStatus]);

  return (
    <div className="app-root">
      <header className="app-topbar">
        <span className="app-topbar-title">{TITLES[pathname] ?? "Zintus"}</span>
        <div className="app-topbar-actions">
          <ThemeToggle />
        </div>
      </header>

      {checked && !gatewayConnected && (
        <GatewayOfflineBanner url={GATEWAY_URL} />
      )}

      <div className="app-body">
        <Sidebar
          collapsed={collapsed}
          onToggle={() => setCollapsed((value) => !value)}
          gatewayConnected={gatewayConnected}
        />
        <div className="app-content">
          {children}
        </div>
      </div>
    </div>
  );
}
