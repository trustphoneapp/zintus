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
import { useSidebarStore } from "@/lib/sidebar-store";

const TITLES: Record<string, string> = {
  "/chat": "Chat",
  "/compare": "Compare",
  "/research": "Research",
  "/agent": "Agent",
  "/terminal": "Terminal",
  "/providers": "Providers",
  "/usage": "Usage",
  "/settings": "Settings",
  "/settings/mcp": "MCP servers",
};

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // Sidebar open/closed lives in a shared store so the header hamburger (here
  // AND in the chat header, a different tree) and the <Sidebar> agree. `open`
  // defaults true on the server + first client render; the persisted choice is
  // applied after mount (no hydration mismatch).
  const { open: sidebarOpen, toggle: toggleSidebar, hydrate: hydrateSidebar } =
    useSidebarStore();
  const collapsed = !sidebarOpen;
  useEffect(() => {
    hydrateSidebar();
  }, [hydrateSidebar]);
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

  // The chat page renders its OWN full header (model pill + Search/Share/Theme/
  // Private), matching the design's single-bar layout — so suppress the global
  // top bar there to avoid a stacked double header (and duplicate Search).
  const hideTopbar = pathname === "/chat";

  return (
    <div className="app-root">
      <CommandPalette />
      {!hideTopbar ? (
      <header className="app-topbar">
        <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
          <Tooltip content={collapsed ? "Expand sidebar" : "Collapse sidebar"} side="bottom">
            <button
              type="button"
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={toggleSidebar}
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
      ) : null}

      {checked && !gatewayConnected && (
        <GatewayOfflineBanner url={GATEWAY_URL} />
      )}

      <div className="app-body">
        <Sidebar
          collapsed={collapsed}
          onToggle={toggleSidebar}
          gatewayConnected={gatewayConnected}
        />
        <div className="app-content">
          {children}
        </div>
      </div>
    </div>
  );
}
