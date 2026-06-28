"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { fetchGatewayHealth, GATEWAY_URL } from "@/lib/gateway";
import { useAppStore } from "@/lib/app-store";
import { ThemeToggle } from "@/components/marketing/ThemeToggle";
import { Tooltip } from "@/components/ui/Tooltip";
import { Sidebar } from "./Sidebar";
import { GatewayOfflineBanner } from "./GatewayOfflineBanner";
import { CommandPalette } from "./CommandPalette";

const TITLES: Record<string, string> = {
  "/chat": "Chat",
  "/compare": "Compare",
  "/research": "Research",
  "/terminal": "Terminal",
  "/providers": "Providers",
  "/usage": "Usage",
  "/settings": "Settings",
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // Default false on BOTH the server and the first client render so hydration
  // matches; the persisted value is applied after mount (effect below). Reading
  // localStorage in the initializer made the first client render disagree with
  // the server HTML → "hydration failed" recoverable error.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    setCollapsed(localStorage.getItem("zintus:sidebar") === "collapsed");
  }, []);
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

  // Drive the existing global ⌘K listener (owned by CommandPalette) so the
  // header affordance and the keyboard shortcut share one code path.
  const openCommandPalette = () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
    );
  };

  return (
    <div className="app-root">
      <CommandPalette />
      <header className="app-topbar">
        <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
          <Tooltip content={collapsed ? "Expand sidebar" : "Collapse sidebar"} side="bottom">
            <button
              type="button"
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={() => {
                setCollapsed((value) => {
                  const next = !value;
                  localStorage.setItem("zintus:sidebar", next ? "collapsed" : "open");
                  return next;
                });
              }}
              style={{ background: "none", border: "none", cursor: "pointer", padding: "4px 6px", color: "inherit", display: "flex", alignItems: "center" }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>
          </Tooltip>
          <span className="app-topbar-title">{TITLES[pathname] ?? "Zintus"}</span>
        </div>
        <div className="app-topbar-actions">
          <Tooltip content="Search and commands" side="bottom">
            <button
              type="button"
              className="topbar-pill"
              aria-label="Open command palette"
              onClick={openCommandPalette}
              style={{ cursor: "pointer" }}
            >
              <span>Search</span>
              <kbd
                style={{
                  padding: "1px 5px",
                  borderRadius: "var(--radius-sm)",
                  border: "0.5px solid var(--c-border)",
                  background: "var(--c-bg)",
                  fontSize: "10px",
                  lineHeight: 1.4,
                }}
              >
                ⌘K
              </kbd>
            </button>
          </Tooltip>
          <ThemeToggle />
        </div>
      </header>

      {checked && !gatewayConnected && (
        <GatewayOfflineBanner url={GATEWAY_URL} />
      )}

      <div className="app-body">
        <Sidebar
          collapsed={collapsed}
          onToggle={() => {
            setCollapsed((value) => {
              const next = !value;
              localStorage.setItem("zintus:sidebar", next ? "collapsed" : "open");
              return next;
            });
          }}
          gatewayConnected={gatewayConnected}
        />
        <div className="app-content">
          {children}
        </div>
      </div>
    </div>
  );
}
