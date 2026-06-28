"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { getGatewayUrl } from "@/lib/gateway";
import { useAppStore } from "@/lib/app-store";
import { ZintusLogo } from "@/components/ZintusLogo";
import { Tooltip } from "@/components/ui/Tooltip";
import { Icon } from "./Icons";

const SECTIONS: Array<{
  label: string;
  items: Array<{
    href: string;
    icon: "chat" | "compare" | "globe" | "layers" | "zap" | "activity" | "terminal" | "settings";
    label: string;
  }>;
}> = [
  {
    label: "Workspace",
    items: [
      { href: "/chat", icon: "chat", label: "Chat" },
      { href: "/compare", icon: "compare", label: "Compare" },
      { href: "/research", icon: "globe", label: "Research" },
      { href: "/projects", icon: "layers", label: "Projects" },
    ],
  },
  {
    label: "Manage",
    items: [
      { href: "/providers", icon: "zap", label: "Providers" },
      { href: "/usage", icon: "activity", label: "Usage" },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/terminal", icon: "terminal", label: "Terminal" },
      { href: "/settings", icon: "settings", label: "Settings" },
    ],
  },
];

function ThreadRow({
  id,
  title,
  active,
  onSwitch,
}: {
  id: string;
  title: string;
  active: boolean;
  onSwitch: () => void;
}) {
  const renameThread = useAppStore((state) => state.renameThread);
  const deleteThread = useAppStore((state) => state.deleteThread);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep draft in sync with the title prop when not actively editing,
  // so auto-naming (which fires on appendMessage) is reflected when the
  // user later opens the rename input.
  useEffect(() => {
    if (!editing) {
      setDraft(title);
    }
  }, [title, editing]);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    function onClick(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function commitRename() {
    renameThread(id, draft);
    setEditing(false);
  }

  function cancelRename() {
    setDraft(title);
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="sidebar-thread editing">
        <input
          ref={inputRef}
          className="sidebar-thread-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitRename();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancelRename();
            }
          }}
        />
        <Tooltip content="Save name">
          <button
            type="button"
            className="sidebar-thread-action"
            aria-label="Save name"
            onClick={commitRename}
          >
            <Icon name="check" size={13} />
          </button>
        </Tooltip>
        <Tooltip content="Cancel rename">
          <button
            type="button"
            className="sidebar-thread-action"
            aria-label="Cancel rename"
            onClick={cancelRename}
          >
            <Icon name="x" size={13} />
          </button>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className={`sidebar-thread${active ? " active" : ""}`}>
      <button type="button" className="sidebar-thread-button" onClick={onSwitch}>
        <span className="sidebar-thread-title">{title}</span>
      </button>
      <div className="sidebar-thread-menu" ref={menuRef}>
        <Tooltip content="Rename or delete">
          <button
            type="button"
            className="sidebar-thread-action"
            aria-label="Thread options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
          >
            <Icon name="more-horizontal" size={14} />
          </button>
        </Tooltip>
        {menuOpen ? (
          <div className="sidebar-thread-dropdown" role="menu">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                setEditing(true);
              }}
            >
              <Icon name="pencil" size={13} />
              Rename
            </button>
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={() => {
                setMenuOpen(false);
                if (window.confirm(`Delete "${title}"? This can't be undone.`)) {
                  deleteThread(id);
                }
              }}
            >
              <Icon name="trash" size={13} />
              Delete
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function Sidebar({
  collapsed,
  onToggle,
  gatewayConnected,
}: {
  collapsed: boolean;
  onToggle: () => void;
  gatewayConnected: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const newChat = useAppStore((state) => state.newChat);
  const switchThread = useAppStore((state) => state.switchThread);
  const threads = useAppStore((state) => state.threads);
  const activeThreadId = useAppStore((state) => state.activeThreadId);

  const [search, setSearch] = useState("");
  const sortedThreads = [...threads]
    .filter((t) => t.messages.length > 0 && !t.incognito)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const query = search.trim().toLowerCase();
  const visibleThreads = query
    ? sortedThreads.filter(
        (t) =>
          t.title.toLowerCase().includes(query) ||
          t.messages.some((m) => m.content.toLowerCase().includes(query)),
      )
    : sortedThreads;

  return (
    <aside className={`app-sidebar${collapsed ? " collapsed" : ""}`}>
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <ZintusLogo size="sm" showWordmark={false} />
        </div>
        {!collapsed ? <span className="sidebar-brand">Zintus</span> : null}
        <Tooltip content={collapsed ? "Expand sidebar" : "Collapse sidebar"} side="right">
          <button
            type="button"
            className="sidebar-toggle"
            onClick={onToggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <Icon name="menu" size={16} />
          </button>
        </Tooltip>
      </div>

      <button
        type="button"
        className="sidebar-newchat"
        title={collapsed ? "New chat" : undefined}
        onClick={() => {
          newChat();
          router.push("/chat");
        }}
      >
        <Icon name="plus" size={16} />
        {!collapsed ? <span>New chat</span> : null}
      </button>

      <nav className="sidebar-nav">
        {SECTIONS.map((section) => (
          <div key={section.label} className="sidebar-section">
            {!collapsed ? (
              <span className="sidebar-section-label">{section.label}</span>
            ) : null}
            {section.items.map((item) => {
              const active =
                pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`sidebar-link${active ? " active" : ""}`}
                  title={collapsed ? item.label : undefined}
                >
                  <Icon name={item.icon} size={17} />
                  {!collapsed ? <span>{item.label}</span> : null}
                  {active && !collapsed ? (
                    <span className="sidebar-active-dot" />
                  ) : null}
                </Link>
              );
            })}
          </div>
        ))}

        {!collapsed && sortedThreads.length > 0 ? (
          <div className="sidebar-section">
            <span className="sidebar-section-label">Recents</span>
            <input
              type="search"
              className="sidebar-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search conversations…"
            />
            <div className="sidebar-threads">
              {visibleThreads.length === 0 ? (
                <p className="sidebar-search-empty">No matches</p>
              ) : null}
              {visibleThreads.map((thread) => (
                <ThreadRow
                  key={thread.id}
                  id={thread.id}
                  title={thread.title}
                  active={thread.id === activeThreadId && pathname === "/chat"}
                  onSwitch={() => {
                    switchThread(thread.id);
                    router.push("/chat");
                  }}
                />
              ))}
            </div>
          </div>
        ) : null}
      </nav>

      {!collapsed ? (
        <div className="sidebar-footer">
          <div className="sidebar-status">
            <span className={`status-dot${gatewayConnected ? " online" : ""}`} />
            <span>{gatewayConnected ? "Gateway connected" : "Gateway offline"}</span>
          </div>
          <div className="sidebar-substatus">
            {gatewayConnected ? getGatewayUrl() : "Start: zintus serve"}
          </div>
        </div>
      ) : null}
    </aside>
  );
}
