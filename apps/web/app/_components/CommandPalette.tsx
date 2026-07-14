"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ProviderId, RoutingStrategy } from "@zintus/types";
import { PROVIDERS } from "@/lib/providers";
import { useAppStore } from "@/lib/app-store";
import { useSettingsStore } from "@/lib/store";

interface Command {
  id: string;
  label: string;
  group: string;
  run: () => void;
}

const STRATEGIES: Array<{ value: RoutingStrategy; label: string }> = [
  { value: "fastest", label: "Auto routing (fastest)" },
  { value: "economy", label: "Economy routing (cheapest)" },
  { value: "capability", label: "Quality routing (best model)" },
];

/**
 * Global Cmd/Ctrl+K command palette. Pure client-side filtering so it opens
 * instantly. Mounted once in AppShell.
 */
export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((v) => !v);
      } else if (event.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // Focus after the modal paints.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const close = () => setOpen(false);
    const go = (href: string) => {
      router.push(href);
      close();
    };
    const store = useAppStore.getState();
    const settings = useSettingsStore.getState();

    const list: Command[] = [
      {
        id: "new-chat",
        label: "New chat",
        group: "Actions",
        run: () => {
          store.newChat();
          go("/chat");
        },
      },
      { id: "open-compare", label: "Open Compare", group: "Actions", run: () => go("/compare") },
      { id: "open-research", label: "Open Research", group: "Actions", run: () => go("/research") },
      { id: "open-engineer", label: "Open Engineer", group: "Actions", run: () => go("/engineer") },
      { id: "nav-providers", label: "Go to Providers", group: "Navigate", run: () => go("/providers") },
      { id: "nav-usage", label: "Go to Usage", group: "Navigate", run: () => go("/usage") },
      { id: "nav-settings", label: "Go to Settings", group: "Navigate", run: () => go("/settings") },
    ];

    for (const strategy of STRATEGIES) {
      list.push({
        id: `strategy-${strategy.value}`,
        label: strategy.label,
        group: "Routing",
        run: () => {
          settings.update({ routingStrategy: strategy.value });
          store.setSelectedProvider(null);
          close();
        },
      });
    }

    for (const provider of PROVIDERS) {
      list.push({
        id: `provider-${provider.id}`,
        label: `Switch to ${provider.name}`,
        group: "Providers",
        run: () => {
          store.setSelectedProvider(provider.id as ProviderId);
          close();
        },
      });
    }

    for (const thread of [...store.threads]
      .filter((t) => t.messages.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 5)) {
      list.push({
        id: `thread-${thread.id}`,
        label: thread.title,
        group: "Recent chats",
        run: () => {
          store.switchThread(thread.id);
          go("/chat");
        },
      });
    }

    return list;
    // Rebuild when the palette opens so "Recent chats" reflects current threads.
  }, [router, open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return commands;
    }
    return commands.filter((command) =>
      command.label.toLowerCase().includes(q),
    );
  }, [commands, query]);

  if (!open) {
    return null;
  }

  const kbdStyle: React.CSSProperties = {
    minWidth: "18px",
    padding: "1px 5px",
    borderRadius: "var(--radius-sm)",
    border: "0.5px solid var(--c-border)",
    background: "var(--c-bg)",
    fontFamily: "var(--font-mono)",
    fontSize: "10px",
    textAlign: "center",
    color: "var(--color-text-muted)",
  };

  const clampedActive = Math.min(active, Math.max(0, filtered.length - 1));

  // Group the flat (keyboard-navigable) list into ordered sections for render,
  // preserving first-seen group order. Keyboard nav still runs over `filtered`.
  const groups: Array<{ name: string; items: Command[] }> = [];
  for (const command of filtered) {
    const last = groups[groups.length - 1];
    if (last && last.name === command.group) {
      last.items.push(command);
    } else {
      groups.push({ name: command.group, items: [command] });
    }
  }

  return (
    <div className="cmdk-overlay" onClick={() => setOpen(false)}>
      <div
        className="cmdk-modal"
        role="dialog"
        aria-modal="true"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="cmdk-input"
          value={query}
          placeholder="Type a command or search…"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((i) => Math.min(i + 1, filtered.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              filtered[clampedActive]?.run();
            }
          }}
        />
        <div className="cmdk-list">
          {filtered.length === 0 ? (
            <div className="cmdk-empty">No matches</div>
          ) : (
            groups.map((group) => (
              <div key={group.name} role="group" aria-label={group.name}>
                <div
                  className="cmdk-group"
                  style={{ padding: "10px 10px 4px", display: "block" }}
                >
                  {group.name}
                </div>
                {group.items.map((command) => {
                  const index = filtered.indexOf(command);
                  const isActive = index === clampedActive;
                  return (
                    <button
                      key={command.id}
                      type="button"
                      className={`cmdk-item${isActive ? " active" : ""}`}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => command.run()}
                    >
                      <span>{command.label}</span>
                      {isActive ? <kbd>↵</kbd> : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "14px",
            padding: "9px 14px",
            borderTop: "0.5px solid var(--c-border)",
            fontSize: "11px",
            color: "var(--color-text-muted)",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
            <kbd style={kbdStyle}>↑</kbd>
            <kbd style={kbdStyle}>↓</kbd>
            navigate
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
            <kbd style={kbdStyle}>↵</kbd>
            select
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
            <kbd style={kbdStyle}>esc</kbd>
            close
          </span>
        </div>
      </div>
    </div>
  );
}
