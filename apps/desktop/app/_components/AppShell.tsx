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
  BarChart3,
  Bot,
  FolderOpen,
  LayoutGrid,
  MessageSquare,
  Pencil,
  Plus,
  Search,
  Settings,
  Trash2,
} from "lucide-react";
import { fetchGatewayHealth, getGatewayUrl } from "@/lib/gateway";
import { isTauri } from "@/lib/tauri";
import { useChatStore } from "@/lib/store";
import { hasCompletedOnboarding } from "@/lib/onboarding";
import { OnboardingOverlay } from "./OnboardingOverlay";
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

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [online, setOnline] = useState(true);
  const [checked, setChecked] = useState(false);

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

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
      {showOnboarding ? (
        <OnboardingOverlay onDone={() => setShowOnboarding(false)} />
      ) : null}

      {/* ── Sidebar: the app frame ─────────────────────────────────────── */}
      <aside
        style={{
          width: 236,
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
            gap: 8,
            padding: "0 14px 10px",
          }}
        >
          <span
            style={{
              fontSize: 17,
              fontWeight: 700,
              color: "var(--color-text)",
              letterSpacing: "-0.01em",
            }}
          >
            Zintus
          </span>
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
          </button>
        </div>

        {/* Primary nav */}
        <nav style={{ padding: "4px 10px 8px", display: "flex", flexDirection: "column", gap: 1 }}>
          {NAV.map((item) => {
            const active =
              pathname === item.href || pathname.startsWith(`${item.href}/`);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`app-nav-link${active ? " active" : ""}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "7px 10px",
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
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* History */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
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
          <input
            ref={threadSearchRef}
            value={threadQuery}
            onChange={(e) => setThreadQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setThreadQuery("");
            }}
            placeholder="Search chats"
            aria-label="Search chats"
            style={{
              margin: "0 2px 6px",
              padding: "5px 8px",
              border: "1px solid var(--color-border)",
              borderRadius: 6,
              background: "var(--color-bg)",
              color: "var(--color-text)",
              fontSize: 12,
            }}
          />
          <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 1 }}>
            {recentThreads.length === 0 ? (
              <div style={{ padding: "4px 8px", fontSize: 12, color: "var(--color-text-muted)" }}>
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
                        <Pencil size={12} />
                      </button>
                      <button
                        type="button"
                        className="ds-thread-action"
                        aria-label={`Delete ${thread.title}`}
                        title="Delete"
                        onClick={() => confirmDelete(thread.id, thread.title)}
                        style={threadActionStyle}
                      >
                        <Trash2 size={12} />
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Status footer */}
        <div
          style={{
            flexShrink: 0,
            borderTop: "1px solid var(--color-border)",
            padding: "8px 14px",
            display: "flex",
            alignItems: "center",
            gap: 7,
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: online ? "var(--color-text-sub)" : "var(--color-red)",
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
        </div>
      </aside>

      {/* ── Main pane ──────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
        {/* Slim drag strip so the window stays draggable over content too. */}
        <div data-tauri-drag-region style={{ height: 14, flexShrink: 0 }} />
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
