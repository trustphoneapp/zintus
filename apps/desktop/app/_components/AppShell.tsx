"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { fetchGatewayHealth, getGatewayUrl } from "@/lib/gateway";
import { useChatStore } from "@/lib/store";
import { Tooltip } from "./ui/tooltip";

const NAV = [
  { href: "/chat", label: "Chat" },
  { href: "/research", label: "Research" },
  { href: "/terminal", label: "Terminal" },
  { href: "/providers", label: "Providers" },
  { href: "/usage", label: "Usage" },
  { href: "/settings", label: "Settings" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [online, setOnline] = useState(true);
  const [checked, setChecked] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("zintus:desktop-sidebar") === "collapsed";
    }
    return false;
  });

  const { threads, activeThreadId, switchThread, newChat } = useChatStore();

  const recentThreads = [...threads]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 10);

  useEffect(() => {
    let active = true;
    async function refresh() {
      const result = await fetchGatewayHealth();
      if (!active) return;
      setOnline(Boolean(result?.health.ok));
      setChecked(true);
    }
    refresh();
    const interval = window.setInterval(refresh, 3000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  const toggleSidebar = () => {
    setCollapsed((v) => {
      const next = !v;
      localStorage.setItem("zintus:desktop-sidebar", next ? "collapsed" : "open");
      return next;
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: "1px solid var(--color-border)",
          background: "var(--color-surface)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Tooltip content={collapsed ? "Expand sidebar" : "Collapse sidebar"} side="bottom">
            <button
              type="button"
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={toggleSidebar}
              className="app-icon-btn"
              style={{
                border: "none",
                cursor: "pointer",
                padding: "4px 6px",
                color: "var(--color-text-sub)",
                display: "flex",
                alignItems: "center",
                borderRadius: 6,
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>
          </Tooltip>
          <span style={{ fontSize: 20, fontWeight: 700, color: "var(--color-purple-light)" }}>
            Zintus
          </span>
        </div>
        <nav style={{ display: "flex", gap: 4 }}>
          {NAV.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`app-nav-link${active ? " active" : ""}`}
                style={{
                  padding: "6px 12px",
                  borderRadius: 8,
                  fontSize: 14,
                  color: active ? "var(--color-text)" : "var(--color-text-sub)",
                }}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>
      {checked && !online && (
        <div
          role="status"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 8,
            padding: "8px 16px",
            fontSize: 13,
            background: "var(--color-surface)",
            color: "var(--color-text-sub)",
            // Calm hairline — the red status dot carries the alert.
            borderBottom: "1px solid color-mix(in srgb, var(--color-red) 40%, var(--color-border))",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "var(--color-red)",
            }}
          />
          <span>
            Gateway offline — run{" "}
            <code
              style={{
                padding: "1px 6px",
                borderRadius: 4,
                background: "var(--color-bg)",
                color: "var(--color-text)",
              }}
            >
              zintus serve
            </code>
          </span>
          <span style={{ color: "var(--color-text-sub)" }}>
            Expecting it at {getGatewayUrl()}
          </span>
        </div>
      )}
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* Left sidebar */}
        <aside
          style={{
            width: collapsed ? 52 : 200,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            background: "var(--color-surface)",
            borderRight: "1px solid var(--color-border)",
            transition: "width 0.2s ease",
            overflow: "hidden",
          }}
        >
          {/* New chat button */}
          <Tooltip content="New chat" side={collapsed ? "right" : "bottom"}>
            <button
              type="button"
              onClick={newChat}
              aria-label="New chat"
              className="app-icon-btn"
              style={{
                display: "flex",
                alignItems: "center",
                gap: collapsed ? 0 : 8,
                padding: collapsed ? "10px 14px" : "10px 12px",
                margin: "8px 6px 4px",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                color: "var(--color-text-sub)",
                fontSize: 13,
                cursor: "pointer",
                whiteSpace: "nowrap",
                overflow: "hidden",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              {!collapsed && <span>New chat</span>}
            </button>
          </Tooltip>

          {/* Thread list when expanded */}
          {!collapsed && (
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                padding: "4px 6px",
                display: "flex",
                flexDirection: "column",
                gap: 2,
              }}
            >
              {recentThreads.map((thread) => {
                const isActive = thread.id === activeThreadId;
                return (
                  <button
                    key={thread.id}
                    type="button"
                    onClick={() => switchThread(thread.id)}
                    title={thread.title}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "6px 8px",
                      border: "none",
                      borderRadius: 6,
                      background: isActive ? "var(--color-purple-faint)" : "transparent",
                      color: isActive ? "var(--color-text)" : "var(--color-text-sub)",
                      fontSize: 12,
                      cursor: "pointer",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {thread.title.length > 36 ? thread.title.slice(0, 36) + "…" : thread.title}
                  </button>
                );
              })}
            </div>
          )}
        </aside>

        {/* Main content */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {children}
        </div>
      </div>
    </div>
  );
}
