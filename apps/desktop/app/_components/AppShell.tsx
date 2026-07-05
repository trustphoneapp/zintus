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
  Bot,
  Check,
  ChevronUp,
  Columns2,
  FolderOpen,
  Globe,
  LayoutGrid,
  MessageSquare,
  MoreHorizontal,
  Moon,
  PanelLeft,
  Pin,
  Plus,
  Search,
  Share,
  ShieldCheck,
  Sun,
} from "lucide-react";
import { fetchGatewayHealth, getGatewayUrl } from "@/lib/gateway";
import { isTauri } from "@/lib/tauri";
import { useChatStore, useCloudStore, useSettingsStore } from "@/lib/store";
import { openExternal } from "@/lib/tauri";
import { signOut } from "@/lib/cloud";
import { hasCompletedOnboarding } from "@/lib/onboarding";
import { listProjects } from "@/lib/projects";
import { saveTextFile } from "@/lib/download";
import { applyTheme, getThemePreference, resolvedTheme, toggleTheme, watchSystemTheme } from "@/lib/theme";
import "@/lib/boot";
import { applyHairline } from "@/lib/hairline";
import { isMacPlatform, stampPlatform, useShortcutGlyphs } from "@/lib/platform";
import { WindowControls } from "./WindowControls";
import { ZintusLogo } from "./ZintusLogo";
import { APP_VERSION, checkForUpdate, type UpdateCheck } from "@/lib/updates";
import { formatSpend, getBudgetUsd, onSpendChange, todaySpendUsd } from "@/lib/spend";
import { OnboardingOverlay } from "./OnboardingOverlay";
import { CommandPalette } from "./CommandPalette";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { Tooltip } from "./ui/tooltip";

/**
 * Desktop shell — the sidebar IS the app frame (the shared grammar of Claude
 * Desktop / Cursor / ChatGPT desktop / OpenCode): navigation, sessions, and
 * status live in one full-height left rail; the macOS titlebar is overlaid on
 * it (traffic lights float over the sidebar top, which doubles as the window
 * drag region); content is a single pane with no web-style top nav.
 */

// V1 sidebar set (Light.dc design) — the prototype's WORKSPACE section, in its
// exact order. Usage and Settings are NOT primary nav: they're reached from the
// account-footer popover (and the top-bar spend button / ⌘,), same as the
// prototype. Terminal intentionally left OUT of the nav — TerminalPane stays in
// the codebase for a later "developer mode"; the Agent page keeps its console.
const NAV = [
  { href: "/chat", label: "Chat", icon: MessageSquare },
  { href: "/models", label: "Models", icon: LayoutGrid },
  { href: "/compare", label: "Compare", icon: Columns2 },
  { href: "/projects", label: "Projects", icon: FolderOpen },
  { href: "/research", label: "Research", icon: Globe },
  { href: "/agent", label: "Agent", icon: Bot },
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

  // Platform chrome (strip height, caption buttons, top-bar padding) is pure
  // CSS keyed on <html data-platform> — stamped pre-paint by
  // PLATFORM_INIT_SCRIPT, so every OS's first frame is already correct.
  // (The old isMac state defaulted true and reflowed on Windows/Linux.)

  // Top-bar state: sidebar collapse (persisted), theme, Private Mode, spend.
  const [collapsed, setCollapsed] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [spend, setSpend] = useState(0);
  const { settings, update: updateSettings, hydrate: hydrateSettings } = useSettingsStore();
  const privateMode = Boolean(settings.blockTrainingProviders);

  useEffect(() => {
    // Re-apply the lib/boot.ts stamps: React 19's hydration of <html> stomps
    // attributes/styles set before it commits (observed live via the S6
    // selftest — data-platform and --hairline were wiped). All idempotent;
    // boot's module-scope pass still covers the pre-hydration frames.
    stampPlatform();
    applyHairline();
    applyTheme(getThemePreference());
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
    setThreadProject,
  } = useChatStore();
  const { authenticated, email, billing, refreshCloud } = useCloudStore();
  // Which thread row is being renamed inline, and the draft title.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // Per-thread ⋯ overflow menu + the account-footer popover.
  const [threadMenuId, setThreadMenuId] = useState<string | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  // Account-popover update check (same honest manifest check Settings uses).
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck | "checking" | null>(null);
  // Top-bar Share (chat only): copies the active thread as Markdown.
  const [shareCopied, setShareCopied] = useState(false);
  // Share menu (copy / save-as-file) — the chat's single export surface.
  const [shareOpen, setShareOpen] = useState(false);
  const shareRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!shareOpen) return;
    function onDown(e: MouseEvent) {
      if (shareRef.current && !shareRef.current.contains(e.target as Node)) {
        setShareOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setShareOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [shareOpen]);
  /** The active thread rendered as shareable Markdown ("" when empty). */
  function activeThreadMarkdown(): string {
    const s = useChatStore.getState();
    const thread = s.threads.find((t) => t.id === s.activeThreadId);
    if (!thread || thread.messages.length === 0) return "";
    return [
      `# ${thread.title}`,
      "",
      ...thread.messages.map((m) =>
        m.role === "user"
          ? `**You:** ${typeof m.content === "string" ? m.content : "[attachments]"}`
          : `**Zintus${m.model ? ` (${m.model})` : ""}:** ${typeof m.content === "string" ? m.content : ""}`,
      ),
    ].join("\n\n");
  }
  const { mod } = useShortcutGlyphs();
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
  // Cloud/billing state stays live without a restart: re-pull on window focus
  // (the user comes back from browser checkout/sign-in) and on a slow interval
  // as a fallback. refreshCloud self-guards against overlapping calls.
  useEffect(() => {
    void refreshCloud();
    const onFocus = () => void refreshCloud();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshCloud();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    const interval = window.setInterval(() => void refreshCloud(), 60_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(interval);
    };
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
      } else if (e.key === "/") {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("zintus:shortcuts"));
      } else if ((e.key === "w" || e.key === "W") && !isMacPlatform()) {
        // macOS gets Cmd+W from the native menu; the undecorated Windows
        // build (and Linux) needs the chord wired by hand (R6 item 4).
        e.preventDefault();
        void (async () => {
          try {
            const { getCurrentWindow } = await import("@tauri-apps/api/window");
            await getCurrentWindow().close();
          } catch {
            /* plain-browser dev — nothing to close */
          }
        })();
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
      <ShortcutsOverlay />

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
        {/* Titlebar zone: mac traffic lights float here (overlay titlebar);
            on the undecorated Windows build it is part of the drag surface.
            Height is CSS per data-platform (.titlebar-strip). */}
        <div data-tauri-drag-region className="titlebar-strip" />

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
          <ZintusLogo size={26} />
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
                  {mod("N")}
                </span>
              </>
            ) : null}
          </button>
        </div>

        {/* Primary nav */}
        {!collapsed ? (
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: 0.6,
              color: "var(--color-text-muted)",
              padding: "4px 20px 4px",
            }}
          >
            Workspace
          </div>
        ) : null}
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
            Recents
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
                            className="pop-menu"
                            style={{
                              position: "absolute",
                              right: 0,
                              top: 24,
                              minWidth: 150,
                              display: "flex",
                              flexDirection: "column",
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
                            {/* Add to project — flat list (minimal, no submenu):
                                one item per project, ✓ on the current one;
                                choosing the current project detaches. */}
                            {listProjects().length > 0 ? (
                              listProjects().map((project) => (
                                <button
                                  key={project.id}
                                  type="button"
                                  role="menuitem"
                                  className="app-icon-btn"
                                  style={threadMenuItemStyle}
                                  onClick={() => {
                                    setThreadProject(
                                      thread.id,
                                      thread.projectId === project.id ? null : project.id,
                                    );
                                    setThreadMenuId(null);
                                  }}
                                >
                                  {thread.projectId === project.id ? "✓ " : ""}
                                  {thread.projectId === project.id
                                    ? `In ${project.name}`
                                    : `Add to ${project.name}`}
                                </button>
                              ))
                            ) : (
                              <Link
                                href="/projects"
                                role="menuitem"
                                className="app-icon-btn"
                                style={{ ...threadMenuItemStyle, textDecoration: "none" }}
                                onClick={() => setThreadMenuId(null)}
                              >
                                Add to project… (create one)
                              </Link>
                            )}
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
              className="pop-menu"
              style={{
                position: "absolute",
                bottom: "calc(100% + 6px)",
                left: 8,
                right: collapsed ? "auto" : 8,
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
                  {mod(",")}
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
              <button
                type="button"
                role="menuitem"
                className="app-icon-btn"
                style={threadMenuItemStyle}
                onClick={() => {
                  setAccountOpen(false);
                  window.dispatchEvent(new CustomEvent("zintus:shortcuts"));
                }}
              >
                Keyboard shortcuts
                <span style={{ marginLeft: "auto", fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--color-text-muted)" }}>
                  {mod("/")}
                </span>
              </button>
              <div style={{ height: 1, background: "var(--color-border)", margin: "4px 8px" }} />
              <button
                type="button"
                role="menuitem"
                className="app-icon-btn"
                style={threadMenuItemStyle}
                disabled={updateCheck === "checking"}
                onClick={() => {
                  if (updateCheck && updateCheck !== "checking" && updateCheck.status === "update") {
                    void openExternal(updateCheck.info.url);
                    setAccountOpen(false);
                    return;
                  }
                  setUpdateCheck("checking");
                  void checkForUpdate().then(setUpdateCheck);
                }}
              >
                {updateCheck === "checking"
                  ? "Checking for updates…"
                  : updateCheck?.status === "update"
                    ? `Update ready · ${updateCheck.info.version} — download`
                    : updateCheck?.status === "current"
                      ? `Up to date · ${APP_VERSION}`
                      : updateCheck?.status === "unreachable"
                        ? "Release feed unreachable — retry"
                        : "Check for updates"}
                {updateCheck !== "checking" && updateCheck?.status === "update" ? (
                  <span aria-hidden style={{ marginLeft: "auto", color: "var(--color-green)" }}>●</span>
                ) : null}
              </button>
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
            shield · spend · theme. Doubles as the window drag region. The
            custom Windows caption buttons are fixed top-right; .app-topbar
            reserves their room per data-platform (globals.css). */}
        <WindowControls />
        <div
          data-tauri-drag-region
          className="app-topbar"
          style={{
            height: 52,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
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
                {mod("K")}
              </span>
            </button>
          </div>

          {pathname.startsWith("/chat") ? (
            // Share = the ONE export surface (the per-chat Export button is
            // gone): copy the chat as Markdown or save it as a .md file.
            <div ref={shareRef} style={{ position: "relative" }}>
              <Tooltip
                content={shareCopied ? "Copied as Markdown" : "Share this chat"}
                side="bottom"
              >
                <button
                  type="button"
                  onClick={() => setShareOpen((v) => !v)}
                  aria-label="Share chat"
                  aria-expanded={shareOpen}
                  className="app-icon-btn"
                  style={{
                    display: "grid",
                    placeItems: "center",
                    width: 32,
                    height: 32,
                    border: "none",
                    borderRadius: 8,
                    background: "transparent",
                    color: shareCopied ? "var(--color-green)" : "var(--color-text-sub)",
                    cursor: "pointer",
                  }}
                >
                  {shareCopied ? <Check size={16} /> : <Share size={15} />}
                </button>
              </Tooltip>
              {shareOpen ? (
                <div
                  role="menu"
                  className="pop-menu"
                  style={{ position: "absolute", top: 38, right: 0, zIndex: 40 }}
                >
                  <div className="pop-label">Share</div>
                  <button
                    type="button"
                    role="menuitem"
                    className="pop-item"
                    onClick={() => {
                      setShareOpen(false);
                      const md = activeThreadMarkdown();
                      if (!md) return;
                      void navigator.clipboard?.writeText(md).then(() => {
                        setShareCopied(true);
                        window.setTimeout(() => setShareCopied(false), 1600);
                      });
                    }}
                  >
                    Copy as Markdown
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="pop-item"
                    onClick={() => {
                      setShareOpen(false);
                      const md = activeThreadMarkdown();
                      if (!md) return;
                      void saveTextFile("zintus-chat.md", md, "text/markdown");
                    }}
                  >
                    Save as .md file
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

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
