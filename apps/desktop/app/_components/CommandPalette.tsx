"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ProviderId, RoutingStrategy } from "@zintus/types";
import { PROVIDER_METADATA } from "@zintus/providers";
import {
  isActiveMember,
  useChatStore,
  useCloudStore,
  useProviderStatusStore,
  useSettingsStore,
} from "@/lib/store";
import { toggleTheme } from "@/lib/theme";

interface Command {
  id: string;
  label: string;
  group: string;
  run: () => void;
}

const STRATEGIES: Array<{ value: RoutingStrategy; label: string }> = [
  { value: "fastest", label: "Route: Fastest (lowest latency)" },
  { value: "economy", label: "Route: Cheapest (lowest cost)" },
  { value: "capability", label: "Route: Capability (best model)" },
];

const PAGES: Array<{ href: string; label: string }> = [
  { href: "/chat", label: "Go to Chat" },
  { href: "/models", label: "Go to Models" },
  { href: "/agent", label: "Go to Agent" },
  { href: "/research", label: "Go to Research" },
  { href: "/projects", label: "Go to Projects" },
  { href: "/usage", label: "Go to Usage" },
  { href: "/settings", label: "Go to Settings" },
];

/**
 * Desktop ⌘K palette (ported from apps/web, adapted to the desktop stores):
 * navigation, routing strategy, Private Mode, theme, BYOK provider switch,
 * managed models (members only — the palette never offers what can't serve),
 * and recent chats. Opens from the top-bar search button too (zintus:cmdk
 * custom event), so the design's centered trigger and the shortcut share one
 * implementation.
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
    function onOpenEvent() {
      setOpen(true);
    }
    document.addEventListener("keydown", onKey);
    window.addEventListener("zintus:cmdk", onOpenEvent);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("zintus:cmdk", onOpenEvent);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const close = () => setOpen(false);
    const go = (href: string) => {
      router.push(href);
      close();
    };
    const chat = useChatStore.getState();
    const providerStore = useProviderStatusStore.getState();
    const settings = useSettingsStore.getState();
    const cloud = useCloudStore.getState();
    const privateMode = Boolean(settings.settings.blockTrainingProviders);

    const list: Command[] = [
      {
        id: "new-chat",
        label: "New chat",
        group: "Actions",
        run: () => {
          chat.newChat();
          go("/chat");
        },
      },
      {
        id: "toggle-private",
        label: privateMode ? "Turn Private Mode off" : "Turn Private Mode on",
        group: "Actions",
        run: () => {
          settings.update({ blockTrainingProviders: !privateMode });
          close();
        },
      },
      {
        id: "toggle-theme",
        label: "Toggle light/dark theme",
        group: "Actions",
        run: () => {
          toggleTheme();
          close();
        },
      },
      ...PAGES.map((page) => ({
        id: `nav-${page.href}`,
        label: page.label,
        group: "Navigate",
        run: () => go(page.href),
      })),
    ];

    for (const strategy of STRATEGIES) {
      list.push({
        id: `strategy-${strategy.value}`,
        label: strategy.label,
        group: "Routing",
        run: () => {
          settings.update({ routingStrategy: strategy.value });
          providerStore.setSelectedProvider(null);
          providerStore.setManagedModel(null);
          close();
        },
      });
    }

    // Managed models — offered only to active members (they actually serve).
    if (isActiveMember(cloud.billing)) {
      for (const model of cloud.managedModels) {
        list.push({
          id: `managed-${model.id}`,
          label: `Use ${model.display_name} (Zintus plan)`,
          group: "Zintus membership",
          run: () => {
            providerStore.setManagedModel(model.id);
            go("/chat");
          },
        });
      }
    }

    for (const [id, meta] of Object.entries(PROVIDER_METADATA)) {
      list.push({
        id: `provider-${id}`,
        label: `Switch to ${meta.name}`,
        group: "Providers",
        run: () => {
          providerStore.setSelectedProvider(id as ProviderId);
          close();
        },
      });
    }

    for (const thread of [...chat.threads]
      .filter((t) => t.messages.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 5)) {
      list.push({
        id: `thread-${thread.id}`,
        label: thread.title,
        group: "Recent chats",
        run: () => {
          chat.switchThread(thread.id);
          go("/chat");
        },
      });
    }

    return list;
    // Rebuild on open so recents/member state are fresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((command) => command.label.toLowerCase().includes(q));
  }, [commands, query]);

  if (!open) return null;

  const kbdStyle: React.CSSProperties = {
    minWidth: 18,
    padding: "1px 5px",
    borderRadius: "var(--radius-sm)",
    border: "0.5px solid var(--c-border)",
    background: "var(--c-bg)",
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    textAlign: "center",
    color: "var(--color-text-muted)",
  };

  const clampedActive = Math.min(active, Math.max(0, filtered.length - 1));

  const groups: Array<{ name: string; items: Command[] }> = [];
  for (const command of filtered) {
    const last = groups[groups.length - 1];
    if (last && last.name === command.group) last.items.push(command);
    else groups.push({ name: command.group, items: [command] });
  }

  return (
    <div className="cmdk-overlay" onClick={() => setOpen(false)}>
      <div
        className="cmdk-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="cmdk-input"
          value={query}
          placeholder="Search chats, actions, models…"
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
                <div className="cmdk-group" style={{ padding: "10px 10px 4px", display: "block" }}>
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
            gap: 14,
            padding: "9px 14px",
            borderTop: "0.5px solid var(--c-border)",
            fontSize: 11,
            color: "var(--color-text-muted)",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <kbd style={kbdStyle}>↑</kbd>
            <kbd style={kbdStyle}>↓</kbd>
            navigate
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <kbd style={kbdStyle}>↵</kbd>
            select
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <kbd style={kbdStyle}>esc</kbd>
            close
          </span>
        </div>
      </div>
    </div>
  );
}
