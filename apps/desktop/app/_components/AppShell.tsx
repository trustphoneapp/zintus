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
import {
  ArrowRight,
  BarChart3,
  Bot,
  ChevronUp,
  FolderOpen,
  LayoutGrid,
  MessageSquare,
  MoreHorizontal,
  Moon,
  PanelLeft,
  Pin,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sun,
} from "lucide-react";
import { fetchGatewayHealth, getGatewayUrl } from "@/lib/gateway";
import { isTauri } from "@/lib/tauri";
import { useChatStore, useCloudStore, useSettingsStore } from "@/lib/store";
import { openExternal } from "@/lib/tauri";
import { signOut } from "@/lib/cloud";
import { hasCompletedOnboarding } from "@/lib/onboarding";
import { resolvedTheme, toggleTheme, watchSystemTheme } from "@/lib/theme";
import { formatSpend, getBudgetUsd, onSpendChange, todaySpendUsd } from "@/lib/spend";
import { OnboardingOverlay } from "./OnboardingOverlay";
import { CommandPalette } from "./CommandPalette";
import { Tooltip } from "./ui/tooltip";

/**
 * Desktop shell — the sidebar IS the app frame (the shared grammar of Claude
 * Desktop / Cursor / ChatGPT desktop / OpenCode): navigation, sessions, and
 * status live in one full-height left rail; the macOS titlebar is overlaid on
 * it (traffic lights float over the sidebar top, which doubles as the window
 * drag region); content is a single pane with no web-style top nav.
 */

// V1 sidebar set (Light.dc design): Models replaces Providers as the primary
// provider/model surface (the /providers route stays reachable, just not from
// primary nav). Terminal intentionally left OUT of the nav — TerminalPane
// stays in the codebase for a later "developer mode"; the Agent page keeps
// its own console for run transparency.
const NAV = [
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/models", label: "Models", icon: LayoutGrid },
  { href: "/agent", label: "Agent", icon: Bot },
  { href: "/research", label: "Research", icon: Search },
  { href: "/projects", label: "Projects", icon: FolderOpen },
  { href: "/usage", label: "Usage", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings },
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

const threadMenuItemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  width: "100%",
  padding: "6px 10px",
  border: "none",
  borderRadius: 7,
  background: "transparent",
  color: "var(--color-text)",
  fontSize: 12.5,
  cursor: "pointer",
  textAlign: "left",
};

const COLLAPSE_KEY = "zintus:sidebar-collapsed";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [online, setOnline] = useState(true);
  const [checked, setChecked] = useState(false);

  // Top-bar state: sidebar collapse (persisted), theme, Private Mode, spend.
  const [collapsed, setCollapsed] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [spend, setSpend] = useState(0);
  const { settings, update: updateSettings, hydrate: hydrateSettings } = useSettingsStore();
  const privateMode = Boolean(settings.blockTrainingProviders);

  useEffect(() => {
    hydrateSettings();
    setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
    setTheme(resolvedTheme());
    setSpend(todaySpendUsd());
    const unsubscribeSpend = onSpendChange(setSpend);
    const unwatchSystem = watchSystemTheme();
    return () => {
      unsubscribeSpend();
      unwatchSystem();
    };
  }, [hydrateSettings]);

  function toggleCollapsed() {
    setCollapsed((current) => {
      const next = !current;
      localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      return next;
    });
  }

  const {
    threads,
    activeThreadId,
    switchThread,
    newChat,
    deleteThread,
    renameThread,
    togglePinThread,
  } = useChatStore();
  const { authenticated, email, billing, refreshCloud } = useCloudStore();
  // Which thread row is being renamed inline, and the draft title.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Per-thread ⋯ overflow menu + the account-footer popover.
  const [threadMenuId, setThreadMenuId] = useState<string | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!accountOpen && !threadMenuId) return;
    function onDown(e: MouseEvent) {
      if (accountRef.current && !accountRef.current.contains(e.target as Node)) {
        setAccountOpen(false);
      }
      setThreadMenuId((current) => {
        if (!current) return current;
        const menu = document.getElementById(`thread-menu-${current}`);
        return menu && menu.contains(e.target as Node) ? current : null;
      });
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setAccountOpen(false);
        setThreadMenuId(null);
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [accountOpen, threadMenuId]);
  useEffect(() => {
    void refreshCloud();
  }, [refreshCloud]);

  // Loaded after mount (localStorage is client-only) to avoid an SSR flash.
  const [showOnboarding, setShowOnboarding] = useState(false);
  useEffect(() => {
    setShowOnboarding(!hasCompletedOnboarding());
  }, []);

  const recentThreads = [...threads]
    .sort(
      (a, b) =>
        Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
        b.updatedAt - a.updatedAt,
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
        // Search history now lives in the ⌘K palette (recent chats group).
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("zintus:cmdk"));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newChat, router]);

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
      {showOnboarding ? (
        <OnboardingOverlay onDone={() => setShowOnboarding(false)} />
      ) : null}
      <CommandPalette />

      {/* ── Sidebar: the app frame ─────────────────────────────────────── */}
      <aside
        style={{
          width: collapsed ? 56 : 236,
          transition: "width 180ms ease",
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          background: "var(--color-surface)",
          borderRight: "1px solid var(--color-border)",
          minHeight: 0,
        }}
      >
        {/* Titlebar zone: traffic lights float here (overlay titlebar); the
            strip is the window drag region. */}
        <div
          data-tauri-drag-region
          style={{ height: 44, flexShrink: 0 }}
        />

        {/* Brand + gateway heartbeat */}
        <div
          data-tauri-drag-region
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: collapsed ? "center" : "flex-start",
            gap: 8,
            padding: collapsed ? "0 0 10px" : "0 14px 10px",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 26,
              height: 26,
              borderRadius: 8,
              flexShrink: 0,
              display: "grid",
              placeItems: "center",
              background: "linear-gradient(135deg, var(--color-purple-mid), #8b7bf7)",
            }}
          >
            <ArrowRight size={14} color="#fff" strokeWidth={2.6} />
          </span>
          {!collapsed ? (
          <span
            style={{
              fontSize: 16,
              fontWeight: 700,
              color: "var(--color-text)",
              letterSpacing: "-0.01em",
            }}
          >
            Zintus
          </span>
          ) : null}
          {checked && (
            <Tooltip
              content={
                online
                  ? `Gateway online at ${getGatewayUrl()}`
                  : "Gateway offline"
              }
              side="bottom"
            >
              <span
                aria-label={online ? "Gateway online" : "Gateway offline"}
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: online ? "var(--color-green)" : "var(--color-red)",
                  boxShadow: online
                    ? "0 0 6px color-mix(in srgb, var(--color-green) 60%, transparent)"
                    : "none",
                }}
              />
            </Tooltip>
          )}
        </div>

        {/* New chat */}
        <div style={{ padding: "0 10px 6px" }}>
          <button
            type="button"
            onClick={() => {
              newChat();
              router.push("/chat");
            }}
            className="app-icon-btn"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "8px 10px",
              border: "1px solid var(--color-border)",
              borderRadius: 8,
              color: "var(--color-text)",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            <Plus size={14} />
            {!collapsed ? (
              <>
                New chat
                <span
                  style={{
                    marginLeft: "auto",
                    fontSize: 10,
                    color: "var(--color-text-muted)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  ⌘N
                </span>
              </>
            ) : null}
          </button>
        </div>

        {/* Primary nav */}
        <nav style={{ padding: "4px 10px 8px", display: "flex", flexDirection: "column", gap: 1 }}>
          {NAV.map((item) => {
            const active =
              pathname === item.href || pathname.startsWith(`${item.href}/`);
            const Icon = item.icon;
            const link = (
              <Link
                key={item.href}
                href={item.href}
                className={`app-nav-link${active ? " active" : ""}`}
                aria-label={item.label}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: collapsed ? "center" : "flex-start",
                  gap: 10,
                  padding: collapsed ? "8px 0" : "7px 10px",
                  borderRadius: 7,
                  fontSize: 13,
                  fontWeight: active ? 600 : 500,
                  textDecoration: "none",
                  color: active ? "var(--color-text)" : "var(--color-text-sub)",
                }}
              >
                <Icon
                  size={15}
                  strokeWidth={active ? 2.2 : 1.8}
                  style={{
                    color: active
                      ? "var(--color-purple-bright)"
                      : "var(--color-text-muted)",
                  }}
                />
                {!collapsed ? item.label : null}
              </Link>
            );
            return collapsed ? (
              <Tooltip key={item.href} content={item.label} side="right">
                {link}
              </Tooltip>
            ) : (
              link
            );
          })}
        </nav>

        {/* History (hidden in the collapsed icon rail) */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: collapsed ? "none" : "flex",
            flexDirection: "column",
            padding: "2px 10px 6px",
            borderTop: "1px solid var(--color-border)",
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 0.6,
              color: "var(--color-text-muted)",
              padding: "10px 8px 6px",
            }}
          >
            History
          </div>
          <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 1 }}>
            {recentThreads.length === 0 ? (
              <div style={{ padding: "4px 8px", fontSize: 12, color: "var(--color-text-muted)" }}>
                No conversations yet.
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
                        onClick={() => {
                          switchThread(thread.id);
                          router.push("/chat");
                        }}
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
                        {thread.title.length > 26
                          ? thread.title.slice(0, 26) + "…"
                          : thread.title}
                      </button>
                      {thread.pinned ? (
                        <Pin
                          size={11}
                          aria-label="Pinned"
                          style={{ flexShrink: 0, color: "var(--color-text-muted)" }}
                        />
                      ) : null}
                      <span style={{ position: "relative", flexShrink: 0 }}>
                        <button
                          type="button"
                          className="ds-thread-action"
                          aria-label={`Options for ${thread.title}`}
                          aria-expanded={threadMenuId === thread.id}
                          title="Options"
                          onClick={() =>
                            setThreadMenuId((current) =>
                              current === thread.id ? null : thread.id,
                            )
                          }
                          style={threadActionStyle}
                        >
                          <MoreHorizontal size={13} />
                        </button>
                        {threadMenuId === thread.id ? (
                          <span
                            id={`thread-menu-${thread.id}`}
                            role="menu"
                            style={{
                              position: "absolute",
                              right: 0,
                              top: 24,
                              minWidth: 130,
                              display: "flex",
                              flexDirection: "column",
                              background: "var(--color-surface)",
                              border: "1px solid var(--color-border)",
                              borderRadius: 9,
                              padding: 3,
                              boxShadow: "var(--shadow-md)",
                              zIndex: 40,
                            }}
                          >
                            <button
                              type="button"
                              role="menuitem"
                              className="app-icon-btn"
                              style={threadMenuItemStyle}
                              onClick={() => {
                                togglePinThread(thread.id);
                                setThreadMenuId(null);
                              }}
                            >
                              {thread.pinned ? "Unpin" : "Pin to top"}
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="app-icon-btn"
                              style={threadMenuItemStyle}
                              onClick={() => {
                                setRenamingId(thread.id);
                                setRenameDraft(thread.title);
                                setThreadMenuId(null);
                              }}
                            >
                              Rename
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="app-icon-btn"
                              style={{ ...threadMenuItemStyle, color: "var(--color-red)" }}
                              onClick={() => {
                                setThreadMenuId(null);
                                confirmDelete(thread.id, thread.title);
                              }}
                            >
                              Delete
                            </button>
                          </span>
                        ) : null}
                      </span>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Rail mode: keep the footer pinned to the bottom while History is hidden. */}
        {collapsed ? <div style={{ flex: 1 }} /> : null}

        {/* Account footer — avatar, name/plan, gateway heartbeat, popover menu. */}
        <div
          ref={accountRef}
          style={{
            position: "relative",
            flexShrink: 0,
            borderTop: "1px solid var(--color-border)",
            padding: collapsed ? "10px 0" : "10px 11px",
          }}
        >
          <button
            type="button"
            onClick={() => setAccountOpen((v) => !v)}
            aria-expanded={accountOpen}
            aria-label="Account and app menu"
            className="app-icon-btn"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: collapsed ? "center" : "flex-start",
              gap: 9,
              width: "100%",
              padding: 4,
              border: "none",
              borderRadius: 9,
              background: "transparent",
              cursor: "pointer",
            }}
          >
            <span
              aria-hidden
              style={{
                width: 28,
                height: 28,
                borderRadius: 8,
                flexShrink: 0,
                display: "grid",
                placeItems: "center",
                background: authenticated
                  ? "var(--color-purple-mid)"
                  : "var(--color-elevated)",
                color: authenticated ? "#fff" : "var(--color-text-sub)",
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              {authenticated && email ? email.slice(0, 2).toUpperCase() : "·"}
            </span>
            {!collapsed ? (
              <>
                <span
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    minWidth: 0,
                    textAlign: "left",
                  }}
                >
                  <span
                    style={{
                      fontSize: 12.5,
                      fontWeight: 600,
                      color: "var(--color-text)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      maxWidth: 130,
                    }}
                  >
                    {authenticated ? (email ?? "Signed in") : "Not signed in"}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      fontFamily: "var(--font-mono)",
                      color: checked
                        ? online
                          ? "var(--color-green)"
                          : "var(--color-red)"
                        : "var(--color-text-muted)",
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: checked
                          ? online
                            ? "var(--color-green)"
                            : "var(--color-red)"
                          : "var(--color-text-muted)",
                      }}
                    />
                    {checked ? (online ? "gateway online" : "gateway offline") : "checking…"}
                  </span>
                </span>
                <ChevronUp
                  size={14}
                  style={{ marginLeft: "auto", color: "var(--color-text-muted)" }}
                />
              </>
            ) : null}
          </button>

          {accountOpen ? (
            <div
              role="menu"
              style={{
                position: "absolute",
                bottom: "calc(100% + 6px)",
                left: 8,
                right: collapsed ? "auto" : 8,
                minWidth: 210,
                background: "var(--color-surface)",
                border: "1px solid var(--color-border)",
                borderRadius: 12,
                padding: 4,
                boxShadow: "var(--shadow-md)",
                zIndex: 50,
              }}
            >
              <div
                style={{
                  padding: "7px 10px 4px",
                  fontSize: 10.5,
                  color: "var(--color-text-muted)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {authenticated
                  ? (email ?? "Signed in")
                  : "Sign in from the Models page to use membership"}
              </div>
              <button
                type="button"
                role="menuitem"
                className="app-icon-btn"
                style={threadMenuItemStyle}
                onClick={() => {
                  setAccountOpen(false);
                  router.push("/models");
                }}
              >
                {billing && billing.tier !== "free"
                  ? `Plan: ${billing.tier[0]!.toUpperCase()}${billing.tier.slice(1)} · manage`
                  : "Plan: Free (BYOK) · upgrade"}
              </button>
              <button
                type="button"
                role="menuitem"
                className="app-icon-btn"
                style={threadMenuItemStyle}
                onClick={() => {
                  setAccountOpen(false);
                  router.push("/settings");
                }}
              >
                Settings
                <span style={{ marginLeft: "auto", fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--color-text-muted)" }}>
                  ⌘,
                </span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="app-icon-btn"
                style={threadMenuItemStyle}
                onClick={() => {
                  setAccountOpen(false);
                  router.push("/usage");
                }}
              >
                Usage &amp; health
              </button>
              <button
                type="button"
                role="menuitem"
                className="app-icon-btn"
                style={threadMenuItemStyle}
                onClick={() => {
                  setAccountOpen(false);
                  void openExternal("https://www.zintus.ai/help");
                }}
              >
                Help &amp; docs ↗
              </button>
              <div style={{ height: 1, background: "var(--color-border)", margin: "4px 8px" }} />
              {authenticated ? (
                <button
                  type="button"
                  role="menuitem"
                  className="app-icon-btn"
                  style={{ ...threadMenuItemStyle, color: "var(--color-text-sub)" }}
                  onClick={() => {
                    setAccountOpen(false);
                    void signOut().then(() => {
                      useCloudStore.getState().resetCloud();
                    });
                  }}
                >
                  Sign out
                </button>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  className="app-icon-btn"
                  style={threadMenuItemStyle}
                  onClick={() => {
                    setAccountOpen(false);
                    router.push("/models");
                  }}
                >
                  Sign in…
                </button>
              )}
            </div>
          ) : null}
        </div>
      </aside>

      {/* ── Main pane ──────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
        {/* Top bar (Light.dc): collapse · [⌘K trigger lands in S3] · privacy
            shield · spend · theme. Doubles as the window drag region. */}
        <div
          data-tauri-drag-region
          style={{
            height: 52,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 14px",
            borderBottom: "1px solid var(--color-border)",
          }}
        >
          <Tooltip content={collapsed ? "Expand sidebar" : "Collapse sidebar"} side="bottom">
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="app-icon-btn"
              style={{
                display: "grid",
                placeItems: "center",
                width: 32,
                height: 32,
                border: "none",
                borderRadius: 8,
                background: "transparent",
                color: "var(--color-text-sub)",
                cursor: "pointer",
              }}
            >
              <PanelLeft size={16} />
            </button>
          </Tooltip>

          <div
            data-tauri-drag-region
            style={{ flex: 1, display: "flex", justifyContent: "center" }}
          >
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent("zintus:cmdk"))}
              aria-label="Search or ask (Command K)"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                width: 300,
                maxWidth: "60%",
                height: 34,
                padding: "0 12px",
                border: "1px solid var(--color-border)",
                borderRadius: 10,
                background: "var(--color-surface)",
                color: "var(--color-text-muted)",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              <Search size={14} />
              Search or ask…
              <span
                style={{
                  marginLeft: "auto",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                }}
              >
                ⌘K
              </span>
            </button>
          </div>

          <Tooltip
            content={
              privateMode
                ? "Private Mode is ON — only providers with a no-training policy serve your chats. Every reply shows whether that was honored."
                : "Private Mode is OFF — click to route only to providers that don't train on your data."
            }
            side="bottom"
          >
            <button
              type="button"
              onClick={() => updateSettings({ blockTrainingProviders: !privateMode })}
              aria-label={privateMode ? "Turn Private Mode off" : "Turn Private Mode on"}
              aria-pressed={privateMode}
              className="app-icon-btn"
              style={{
                display: "grid",
                placeItems: "center",
                width: 32,
                height: 32,
                border: "none",
                borderRadius: 8,
                background: privateMode
                  ? "color-mix(in srgb, var(--color-green) 14%, transparent)"
                  : "transparent",
                color: privateMode ? "var(--color-green)" : "var(--color-text-sub)",
                cursor: "pointer",
              }}
            >
              <ShieldCheck size={16} />
            </button>
          </Tooltip>

          <Tooltip
            content={
              getBudgetUsd() != null && spend >= (getBudgetUsd() ?? Infinity)
                ? `Over your $${getBudgetUsd()} daily budget (soft cap — nothing is blocked). Click for Usage.`
                : "Estimated BYOK spend today (gateway estimates; managed replies bill plan tokens instead). Click for Usage."
            }
            side="bottom"
          >
            <button
              type="button"
              onClick={() => router.push("/usage")}
              className="app-icon-btn"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                height: 30,
                padding: "0 10px",
                border: "none",
                borderRadius: 8,
                background: "transparent",
                color: "var(--color-text-sub)",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              <span
                style={{
                  fontWeight: 600,
                  color:
                    getBudgetUsd() != null && spend >= (getBudgetUsd() ?? Infinity)
                      ? "var(--c-warn)"
                      : "var(--color-text)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11.5,
                }}
              >
                {formatSpend(spend)}
              </span>
              today
            </button>
          </Tooltip>

          <Tooltip content={theme === "light" ? "Switch to dark" : "Switch to light"} side="bottom">
            <button
              type="button"
              onClick={() => setTheme(toggleTheme())}
              aria-label="Toggle theme"
              className="app-icon-btn"
              style={{
                display: "grid",
                placeItems: "center",
                width: 32,
                height: 32,
                border: "none",
                borderRadius: 8,
                background: "transparent",
                color: "var(--color-text-sub)",
                cursor: "pointer",
              }}
            >
              {theme === "light" ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          </Tooltip>
        </div>
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
            {isTauri() ? (
              // The packaged app starts the gateway sidecar itself — offline here
              // is almost always the first seconds of startup, not a user task.
              <span>
                Starting the local gateway… If this persists, quit and reopen the
                app (or run{" "}
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
                ).
              </span>
            ) : (
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
            )}
            <span style={{ color: "var(--color-text-sub)" }}>
              Expecting it at {getGatewayUrl()}
            </span>
          </div>
        )}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {children}
        </div>
      </div>
    </div>
  );
}
