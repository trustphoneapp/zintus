"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { fetchGatewayHealth, getGatewayUrl } from "@/lib/gateway";
import { useChatStore } from "@/lib/store";
import { hasCompletedOnboarding } from "@/lib/onboarding";
import { OnboardingOverlay } from "./OnboardingOverlay";
import { Tooltip } from "./ui/tooltip";

const NAV = [
  { href: "/chat", label: "Chat" },
  { href: "/agent", label: "Agent" },
  { href: "/research", label: "Research" },
  { href: "/projects", label: "Projects" },
  { href: "/terminal", label: "Terminal" },
  { href: "/providers", label: "Providers" },
  { href: "/usage", label: "Usage" },
  { href: "/settings", label: "Settings" },
];

/** Per-thread hover action button (rename / delete). Shown on row hover via CSS. */
const threadActionStyle: CSSProperties = {
  flexShrink: 0,
  border: "none",
  background: "transparent",
  color: "var(--color-text-sub)",
  cursor: "pointer",
  fontSize: 12,
  padding: "4px 6px",
  borderRadius: 4,
  lineHeight: 1,
};

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [online, setOnline] = useState(true);
  const [checked, setChecked] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("zintus:desktop-sidebar") === "collapsed";
    }
    return false;
  });

  const { threads, activeThreadId, switchThread, newChat, deleteThread, renameThread } =
    useChatStore();
  // Which thread row is being renamed inline, and the draft title.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // History search (#16): title filter over the sidebar list; ⌘⇧F focuses it.
  const [threadQuery, setThreadQuery] = useState("");
  const threadSearchRef = useRef<HTMLInputElement>(null);

  // Loaded after mount (localStorage is client-only) to avoid an SSR flash.
  const [showOnboarding, setShowOnboarding] = useState(false);
  useEffect(() => {
    setShowOnboarding(!hasCompletedOnboarding());
  }, []);

  const recentThreads = [...threads]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter(
      (t) =>
        !threadQuery.trim() ||
        t.title.toLowerCase().includes(threadQuery.trim().toLowerCase()),
    )
    .slice(0, 40);

  function commitRename(id: string) {
    if (renameDraft.trim()) renameThread(id, renameDraft);
    setRenamingId(null);
    setRenameDraft("");
  }

  function confirmDelete(id: string, title: string) {
    if (window.confirm(`Delete "${title}"? This can't be undone.`)) {
      deleteThread(id);
    }
  }

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

  // Desktop keyboard shortcuts (Cmd/Ctrl based). Cmd+W/Cmd+Q come from Tauri's
  // default macOS menu; these add the app-level ones the menu doesn't cover.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        newChat();
        router.push("/chat");
      } else if (e.key === ",") {
        e.preventDefault();
        router.push("/settings");
      } else if ((e.key === "f" || e.key === "F") && e.shiftKey) {
        // Search history: jump to chat (where the sidebar lives) and focus
        // the thread filter. rAF lets the route/render land first.
        e.preventDefault();
        router.push("/chat");
        requestAnimationFrame(() => threadSearchRef.current?.focus());
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newChat, router]);

  const toggleSidebar = () => {
    setCollapsed((v) => {
      const next = !v;
      localStorage.setItem("zintus:desktop-sidebar", next ? "collapsed" : "open");
      return next;
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      {showOnboarding ? (
        <OnboardingOverlay onDone={() => setShowOnboarding(false)} />
      ) : null}
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
          <span style={{ fontSize: 20, fontWeight: 700, color: "var(--color-purple-bright)" }}>
            Zintus
          </span>
          {/* Gateway heartbeat — status visible in both states, not just offline. */}
          {checked && (
            <Tooltip content={`Gateway at ${getGatewayUrl()}`} side="bottom">
              <span
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  marginLeft: 8,
                  padding: "3px 8px",
                  borderRadius: 999,
                  border: "1px solid var(--color-border)",
                  fontSize: 11,
                  fontFamily: "var(--font-mono, ui-monospace, monospace)",
                  color: online ? "var(--color-green)" : "var(--color-red)",
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: online ? "var(--color-green)" : "var(--color-red)",
                  }}
                />
                {online ? "gateway" : "offline"}
              </span>
            </Tooltip>
          )}
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
          <Tooltip content="New chat (Ctrl/⌘ N)" side={collapsed ? "right" : "bottom"}>
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
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  color: "var(--color-text-sub)",
                  padding: "6px 8px 2px",
                }}
              >
                History
              </div>
              <input
                ref={threadSearchRef}
                value={threadQuery}
                onChange={(e) => setThreadQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setThreadQuery("");
                }}
                placeholder="Search chats (⌘⇧F)"
                aria-label="Search chats"
                style={{
                  margin: "2px 2px 4px",
                  padding: "5px 8px",
                  border: "1px solid var(--color-border)",
                  borderRadius: 6,
                  background: "var(--color-bg)",
                  color: "var(--color-text)",
                  fontSize: 12,
                }}
              />
              {recentThreads.length === 0 ? (
                <div style={{ padding: "6px 8px", fontSize: 12, color: "var(--color-text-sub)" }}>
                  {threadQuery.trim() ? "No chats match." : "No conversations yet."}
                </div>
              ) : null}
              {recentThreads.map((thread) => {
                const isActive = thread.id === activeThreadId;
                const isRenaming = renamingId === thread.id;
                return (
                  <div
                    key={thread.id}
                    className="ds-thread-row"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      borderRadius: 6,
                      background: isActive ? "var(--color-purple-faint)" : "transparent",
                    }}
                  >
                    {isRenaming ? (
                      <input
                        autoFocus
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onBlur={() => commitRename(thread.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(thread.id);
                          if (e.key === "Escape") {
                            setRenamingId(null);
                            setRenameDraft("");
                          }
                        }}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          padding: "5px 8px",
                          border: "1px solid var(--color-border)",
                          borderRadius: 6,
                          background: "var(--color-bg)",
                          color: "var(--color-text)",
                          fontSize: 12,
                        }}
                      />
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => switchThread(thread.id)}
                          onDoubleClick={() => {
                            setRenamingId(thread.id);
                            setRenameDraft(thread.title);
                          }}
                          title={thread.title}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            textAlign: "left",
                            padding: "6px 8px",
                            border: "none",
                            borderRadius: 6,
                            background: "transparent",
                            color: isActive ? "var(--color-text)" : "var(--color-text-sub)",
                            fontSize: 12,
                            cursor: "pointer",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {thread.title.length > 30
                            ? thread.title.slice(0, 30) + "…"
                            : thread.title}
                        </button>
                        <button
                          type="button"
                          className="ds-thread-action"
                          aria-label={`Rename ${thread.title}`}
                          title="Rename"
                          onClick={() => {
                            setRenamingId(thread.id);
                            setRenameDraft(thread.title);
                          }}
                          style={threadActionStyle}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="ds-thread-action"
                          aria-label={`Delete ${thread.title}`}
                          title="Delete"
                          onClick={() => confirmDelete(thread.id, thread.title)}
                          style={threadActionStyle}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </>
                    )}
                  </div>
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
