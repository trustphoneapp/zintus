"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { fetchGatewayHealth } from "@/lib/gateway";
import { useAppStore } from "@/lib/app-store";
import { Sidebar } from "./Sidebar";

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
      </header>

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
