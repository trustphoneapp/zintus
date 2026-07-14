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
  const {
    open: sidebarOpen,
    toggle: toggleSidebar,
    hydrate: hydrateSidebar,
  } = useSidebarStore();
  const collapsed = !sidebarOpen;
  useEffect(() => {
    hydrateSidebar();
    // Responsive default (V7 11.2): on mobile (≤720) the sidebar is an off-canvas
    // drawer; on tablet (721–1023) it defaults to the 60px icon rail (expanding
    // overlays the content). Both start collapsed on mount so the chat column is
    // full-width. We collapse WITHOUT persisting so a desktop user's saved
    // expand/collapse preference is never overwritten by opening on a narrow
    // window. On desktop (≥1024) the hydrated preference stands.
    if (typeof window !== "undefined" && window.innerWidth <= 1023) {
      useSidebarStore.setState({ open: false });
    }
  }, [hydrateSidebar]);
  // In overlay mode (≤1023 the sidebar is an off-canvas drawer / expanding rail),
  // close it after an in-app navigation so it doesn't stay covering the new page.
  // We set state directly (never the persisted toggle) so a desktop user's saved
  // expand/collapse preference is untouched — and this no-ops at ≥1024.
  useEffect(() => {
    if (typeof window !== "undefined" && window.innerWidth <= 1023) {
      useSidebarStore.setState({ open: false });
    }
  }, [pathname]);
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
        {/* Mobile drawer scrim: only rendered when the sidebar is open; on ≤720px
            it dims the chat behind the off-canvas drawer and closes it on tap. */}
        {!collapsed ? (
          <div
            className="sidebar-scrim"
            aria-hidden
            onClick={toggleSidebar}
          />
        ) : null}
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
