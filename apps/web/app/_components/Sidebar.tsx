"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { getGatewayUrl } from "@/lib/gateway";
import { useAppStore, type Thread } from "@/lib/app-store";
import { signOut, getMe, googleSignInUrl } from "@/lib/cloud";
import { fetchBillingStatus, type BillingStatus } from "@/lib/billing";
import { TIER_LABEL } from "@/lib/chat-top-strip";
import {
  DEFAULT_RECENTS_FILTERS,
  filterRecents,
  isDefaultRecentsFilters,
  type RecentsFilters,
  type RecentsGroupBy,
} from "@/lib/recents-filter";
import { ZintusLogo } from "@/components/ZintusLogo";
import { Tooltip } from "@/components/ui/Tooltip";
import { useDismissableMenu } from "./useDismissableMenu";
import { Icon } from "./Icons";

type NavIcon =
  | "chat" | "compare" | "globe" | "layers" | "grid" | "zap"
  | "activity" | "terminal" | "settings" | "plug" | "database" | "bot";

// Matches the design's sidebar: a single "Workspace" group. Management
// destinations (Providers, MCP, Usage, Settings, Help) live in the account
// popover at the bottom — see AccountBlock.
const SECTIONS: Array<{
  label: string;
  items: Array<{ href: string; icon: NavIcon; label: string }>;
}> = [
  {
    label: "Workspace",
    items: [
      { href: "/chat", icon: "chat", label: "Chat" },
      { href: "/models", icon: "grid", label: "Models" },
      { href: "/compare", icon: "compare", label: "Compare" },
      { href: "/projects", icon: "layers", label: "Projects" },
      { href: "/research", icon: "globe", label: "Research" },
      { href: "/agent", icon: "bot", label: "Agent" },
      { href: "/engineer", icon: "zap", label: "Engineer" },
      { href: "/terminal", icon: "terminal", label: "Terminal" },
    ],
  },
];

// Management links shown inside the account popover (design parity).
const ACCOUNT_LINKS: Array<{ href: string; icon: NavIcon; label: string }> = [
  { href: "/settings", icon: "settings", label: "Settings" },
  { href: "/providers", icon: "zap", label: "Providers & keys" },
  { href: "/settings/mcp", icon: "plug", label: "MCP servers" },
  { href: "/usage", icon: "activity", label: "Usage" },
  { href: "/memory", icon: "database", label: "Memory" },
  { href: "/help", icon: "globe", label: "Help & docs" },
];

/** Group recents into PINNED / Today / Yesterday / Previous 7 days / Older
 *  (10.5). Input is already sorted newest-first; ordering is preserved. */
function groupThreadsByDate(
  threads: Thread[],
  pinned: Set<string>,
): Array<{ label: string; threads: Thread[] }> {
  const now = new Date();
  const startToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startYesterday = startToday - 86_400_000;
  const start7 = startToday - 7 * 86_400_000;
  const pinnedThreads: Thread[] = [];
  const buckets: Record<string, Thread[]> = {
    Today: [],
    Yesterday: [],
    "Previous 7 days": [],
    Older: [],
  };
  for (const t of threads) {
    if (pinned.has(t.id)) {
      pinnedThreads.push(t);
      continue;
    }
    if (t.updatedAt >= startToday) buckets.Today!.push(t);
    else if (t.updatedAt >= startYesterday) buckets.Yesterday!.push(t);
    else if (t.updatedAt >= start7) buckets["Previous 7 days"]!.push(t);
    else buckets.Older!.push(t);
  }
  const groups: Array<{ label: string; threads: Thread[] }> = [];
  if (pinnedThreads.length) groups.push({ label: "Pinned", threads: pinnedThreads });
  for (const label of ["Today", "Yesterday", "Previous 7 days", "Older"] as const) {
    if (buckets[label]!.length) groups.push({ label, threads: buckets[label]! });
  }
  return groups;
}

/** View-level grouping switch driven by the Recents filter popover's "Group"
 *  row: "date" reuses groupThreadsByDate's PINNED/Today/Yesterday/Previous 7
 *  days/Older buckets; "none" is a single pinned-first flat list — one
 *  unlabeled group, so the group-label span simply renders nothing instead of
 *  an empty pill. */
function buildRecentGroups(
  threads: Thread[],
  pinned: Set<string>,
  groupBy: RecentsGroupBy,
): Array<{ label: string; threads: Thread[] }> {
  if (groupBy === "date") return groupThreadsByDate(threads, pinned);
  const pinnedThreads = threads.filter((t) => pinned.has(t.id));
  const rest = threads.filter((t) => !pinned.has(t.id));
  const flat = [...pinnedThreads, ...rest];
  return flat.length ? [{ label: "", threads: flat }] : [];
}

/** Icon-button trigger for the Recents filter popover (RecentsFilterPanel) —
 *  shared by the expanded sidebar's RECENTS header and the collapsed rail's
 *  recents flyout header. The accent dot means "a filter is narrowing this
 *  list", so an active filter is never invisible. */
function RecentsFilterTrigger({
  active,
  open,
  onClick,
}: {
  active: boolean;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="sidebar-filter-trigger"
      title="Filter chats"
      aria-label="Filter chats"
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={onClick}
    >
      <Icon name="sliders" size={14} />
      {active ? <span className="sidebar-filter-trigger-dot" aria-hidden /> : null}
    </button>
  );
}

/** One labeled segmented-control row (Pinned/Activity/Route/Group) inside the
 *  Recents filter popover, styled like AccountBlock's Appearance toggle
 *  (.sidebar-account-theme / -theme-opt) via the sidebar-filter-seg* classes. */
function FilterSegmentRow<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="sidebar-filter-row">
      <span className="sidebar-filter-row-label">{label}</span>
      <div className="sidebar-filter-seg">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={`sidebar-filter-seg-opt${value === opt.value ? " active" : ""}`}
            aria-pressed={value === opt.value}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Recents filter popover content — Pinned/Activity/Route/Group rows + a quiet
 * Reset footer (visible only when something's non-default). Built ONLY from
 * attributes Zintus threads really have (see lib/recents-filter) — there is
 * deliberately no project filter, since threads carry no project linkage.
 */
function RecentsFilterPanel({
  filters,
  setFilters,
  groupBy,
  setGroupBy,
  onReset,
}: {
  filters: RecentsFilters;
  setFilters: (f: RecentsFilters) => void;
  groupBy: RecentsGroupBy;
  setGroupBy: (g: RecentsGroupBy) => void;
  onReset: () => void;
}) {
  const showReset = !isDefaultRecentsFilters(filters) || groupBy !== "date";
  return (
    <div className="sidebar-filter-menu" role="menu">
      <FilterSegmentRow
        label="Pinned"
        value={filters.pinned}
        options={[
          { value: "all", label: "All" },
          { value: "pinned", label: "Pinned" },
        ]}
        onChange={(pinned) => setFilters({ ...filters, pinned })}
      />
      <FilterSegmentRow
        label="Activity"
        value={filters.activity}
        options={[
          { value: "all", label: "All" },
          { value: "today", label: "Today" },
          { value: "week", label: "7d" },
          { value: "month", label: "30d" },
        ]}
        onChange={(activity) => setFilters({ ...filters, activity })}
      />
      <FilterSegmentRow
        label="Route"
        value={filters.route}
        options={[
          { value: "all", label: "All" },
          { value: "membership", label: "Membership" },
          { value: "byok", label: "BYOK" },
        ]}
        onChange={(route) => setFilters({ ...filters, route })}
      />
      <FilterSegmentRow
        label="Group"
        value={groupBy}
        options={[
          { value: "date", label: "Date" },
          { value: "none", label: "None" },
        ]}
        onChange={setGroupBy}
      />
      <div className="sidebar-filter-menu-footer">
        {showReset ? (
          <button type="button" className="sidebar-filter-reset" onClick={onReset}>
            Reset
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ThreadRow({
  id,
  title,
  active,
  pinned,
  onTogglePin,
  onSwitch,
}: {
  id: string;
  title: string;
  active: boolean;
  pinned: boolean;
  onTogglePin: () => void;
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

  // Escape (restores focus to the ⋯ trigger) + click / focus-out dismissal.
  useDismissableMenu(menuOpen, () => setMenuOpen(false), menuRef);

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
      <Tooltip content={pinned ? "Unpin" : "Pin"}>
        <button
          type="button"
          className={`sidebar-thread-pin${pinned ? " is-pinned" : ""}`}
          aria-label={pinned ? "Unpin conversation" : "Pin conversation"}
          aria-pressed={pinned}
          onClick={onTogglePin}
        >
          <Icon name="pin" size={13} />
        </button>
      </Tooltip>
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

/** Small plan chip — semantic green dot + mono label, same visual grammar as
 *  the gateway-status dot below it. Only rendered once billing is known AND
 *  the subscription is active (never a guess). */
function TierBadge({ tier }: { tier: BillingStatus["tier"] }) {
  return (
    <span className="sidebar-account-tier" aria-label={`${TIER_LABEL[tier]} plan active`}>
      <span className="status-dot online" aria-hidden />
      {TIER_LABEL[tier]}
    </span>
  );
}

/**
 * Identity for the sidebar's account UI (rail avatar + expanded account
 * block). getMe() is a cheap authenticated GET, not a read of the session
 * cookie client-side — zintus_session is HttpOnly, so document.cookie can
 * never see it and a cookie-presence gate would never pass. getMe() fails
 * silent to {authenticated:false} when signed out. Fetched once per mount
 * (no polling — the popover's "Sign out" reload and the gateway heartbeat
 * elsewhere cover staleness).
 */
function useAccountInitial() {
  const [signedIn, setSignedIn] = useState(false);
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    void getMe().then((me) => {
      if (!me.authenticated) return;
      setSignedIn(true);
      if (me.email) setEmail(me.email);
    });
  }, []);

  // Two-letter email initials (matches the desktop account avatar) when known,
  // otherwise a generic mark.
  const initial = signedIn ? (email ? email.slice(0, 2).toUpperCase() : "A") : "L";

  return { signedIn, email, initial };
}

/**
 * Bottom-of-sidebar account block (design parity). The design mocks a managed
 * "Starter plan" with a token quota + Top-up — but managed keys are gated off
 * (MANAGED_KEYS_AVAILABLE = false), so we show ONLY honest content here: real
 * estimated savings from the gateway, real sign-in/gateway state, and the
 * management links. No fake plan, no fake quota, no Top-up.
 */
function AccountBlock({ gatewayConnected }: { gatewayConnected: boolean }) {
  const gatewaySavings = useAppStore((s) => s.gatewaySavings);
  const { theme, setTheme } = useTheme();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const { signedIn, email, initial } = useAccountInitial();
  // Billing, fetched once per mount alongside identity (see useAccountInitial
  // above) — fails silent to `null`, so the footer just keeps showing no
  // badge if the relay is unreachable.
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    void fetchBillingStatus().then((status) => {
      if (status) setBilling(status);
    });
  }, [signedIn]);

  // Escape (restores focus to the account trigger) + click / focus-out dismissal.
  useDismissableMenu(open, () => setOpen(false), ref);

  // Sign-in gates account identity, billing/subscription, and gateway-session
  // pairing (see lib/cloud.ts + lib/billing.ts) — there is no chat/thread sync
  // backend, so this copy must never claim chats sync across devices.
  const name = signedIn ? (email ?? "Signed in") : "Local workspace";
  const sub = signedIn ? "Account & billing synced" : "Chats stay on this device";
  const tierActive = signedIn && billing?.status === "active";
  const savedUsd = gatewaySavings?.estimatedUsdSaved ?? 0;
  const isDark = !mounted || theme !== "light";
  // Google OAuth round-trip: land the user back where they were (or /chat)
  // instead of the relay's default dashboard redirect.
  const signInHref = googleSignInUrl(pathname || "/chat");

  return (
    <div className="sidebar-account" ref={ref}>
      {open ? (
        <div className="sidebar-account-menu" role="menu">
          <div className="sidebar-account-id">
            <span className="sidebar-account-avatar" aria-hidden>{initial}</span>
            <div className="sidebar-account-id-text">
              <span className="sidebar-account-name-row">
                <span className="sidebar-account-name">{name}</span>
                {tierActive && billing ? <TierBadge tier={billing.tier} /> : null}
              </span>
              <span className="sidebar-account-sub">{sub}</span>
            </div>
          </div>

          {/* Real, honest savings — not a managed-plan quota. */}
          <div className="sidebar-account-saved">
            <span>Saved vs paid APIs</span>
            <strong className="sidebar-account-saved-amt">
              {gatewayConnected ? `$${savedUsd.toFixed(2)}` : "—"}
            </strong>
          </div>

          {/* Plan row — same "Plan: X · manage" / "Plan: Free (BYOK) ·
              upgrade" grammar as the desktop account menu, so the two apps
              read as one product. Always present once billing is known
              (never a guess while it's still loading). */}
          {signedIn && billing ? (
            <Link
              href={billing.tier !== "free" ? "/dashboard" : "/pricing"}
              className="sidebar-account-link sidebar-account-plan"
              role="menuitem"
              onClick={() => setOpen(false)}
            >
              <span
                className={`status-dot${billing.status === "active" ? " online" : ""}`}
                aria-hidden
              />
              <span>
                {billing.tier !== "free"
                  ? `Plan: ${TIER_LABEL[billing.tier]} · manage`
                  : "Plan: Free (BYOK) · upgrade"}
              </span>
            </Link>
          ) : null}

          <div className="sidebar-account-divider" />

          {ACCOUNT_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="sidebar-account-link"
              role="menuitem"
              onClick={() => setOpen(false)}
            >
              <Icon name={link.icon} size={14} />
              <span>{link.label}</span>
            </Link>
          ))}

          <div className="sidebar-account-divider" />

          {/* Appearance toggle (next-themes). */}
          <div className="sidebar-account-appearance" role="group" aria-label="Appearance">
            <span>Appearance</span>
            <div className="sidebar-account-theme">
              <button
                type="button"
                className={`sidebar-account-theme-opt${isDark ? " active" : ""}`}
                aria-pressed={isDark}
                onClick={() => setTheme("dark")}
              >
                Dark
              </button>
              <button
                type="button"
                className={`sidebar-account-theme-opt${!isDark ? " active" : ""}`}
                aria-pressed={!isDark}
                onClick={() => setTheme("light")}
              >
                Light
              </button>
            </div>
          </div>

          <div className="sidebar-account-divider" />

          {/* Gateway status — honest, links to the docs when offline. */}
          <div className="sidebar-account-gateway">
            <span className={`status-dot${gatewayConnected ? " online" : ""}`} />
            <span className="sidebar-account-gateway-text">
              {gatewayConnected ? "Gateway connected" : "Gateway offline"}
            </span>
            <span className="sidebar-account-gateway-url">
              {gatewayConnected ? getGatewayUrl() : "zintus serve"}
            </span>
          </div>

          {signedIn ? (
            <button
              type="button"
              className="sidebar-account-signout"
              role="menuitem"
              onClick={() => {
                void signOut().finally(() => window.location.reload());
              }}
            >
              Sign out
            </button>
          ) : (
            <a
              href={signInHref}
              className="sidebar-account-signin"
              role="menuitem"
              aria-label="Sign in with Google — returns you to this page"
              onClick={() => setOpen(false)}
            >
              Sign in for account &amp; billing →
            </a>
          )}
        </div>
      ) : null}

      <button
        type="button"
        className="sidebar-account-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="sidebar-account-avatar" aria-hidden>{initial}</span>
        <div className="sidebar-account-trigger-text">
          <span className="sidebar-account-name-row">
            <span className="sidebar-account-name">{name}</span>
            {tierActive && billing ? <TierBadge tier={billing.tier} /> : null}
          </span>
          <span className="sidebar-account-trigger-meta">
            <span className={`status-dot${gatewayConnected ? " online" : ""}`} />
            {gatewayConnected ? `Saved $${savedUsd.toFixed(2)}` : "Gateway offline"}
          </span>
        </div>
        <Icon name="chevron-down" size={13} />
      </button>
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
  const pinnedThreadIds = useAppStore((state) => state.pinnedThreadIds);
  const togglePinThread = useAppStore((state) => state.togglePinThread);
  const { initial } = useAccountInitial();

  const [search, setSearch] = useState("");
  // One-click recents from the collapsed rail (Claude/ChatGPT parity — see
  // the rail button below). Shares `search` with the expanded sidebar's
  // input; harmless since only one of the two UIs is ever mounted.
  const [recentsOpen, setRecentsOpen] = useState(false);
  const recentsRef = useRef<HTMLDivElement>(null);
  useDismissableMenu(recentsOpen, () => setRecentsOpen(false), recentsRef);

  // Recents filter popover (see lib/recents-filter). Ephemeral view state —
  // NOT persisted, so a reload always starts from the honest default (every
  // chat visible, grouped by date). Shared across both the expanded sidebar
  // and the collapsed rail's flyout — only one branch is ever mounted, so one
  // set of state/handlers naturally applies to whichever is showing.
  const [filters, setFilters] = useState<RecentsFilters>(DEFAULT_RECENTS_FILTERS);
  const [groupBy, setGroupBy] = useState<RecentsGroupBy>("date");
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  useDismissableMenu(filterMenuOpen, () => setFilterMenuOpen(false), filterMenuRef);
  const filtersActive = !isDefaultRecentsFilters(filters) || groupBy !== "date";
  function resetRecentsFilters() {
    setFilters(DEFAULT_RECENTS_FILTERS);
    setGroupBy("date");
  }

  const sortedThreads = [...threads]
    .filter((t) => t.messages.length > 0 && !t.incognito)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  // Active nav = the LONGEST href that matches the path, so /settings/mcp lights
  // up "MCP servers" rather than also lighting up its /settings prefix.
  const activeHref = SECTIONS.flatMap((s) => s.items)
    .map((item) => item.href)
    .filter(
      (href) => pathname === href || pathname.startsWith(`${href}/`),
    )
    .sort((a, b) => b.length - a.length)[0];

  const query = search.trim().toLowerCase();
  const visibleThreads = query
    ? sortedThreads.filter(
        (t) =>
          t.title.toLowerCase().includes(query) ||
          t.messages.some((m) => m.content.toLowerCase().includes(query)),
      )
    : sortedThreads;

  // PINNED-first, date-grouped recents (10.5). Search still filters everything;
  // the Recents filter popover (pinned/activity/route) then narrows further,
  // and Group (date vs flat) decides how the result is bucketed.
  const pinnedSet = new Set(pinnedThreadIds);
  const filteredThreads = filterRecents(visibleThreads, pinnedSet, filters, Date.now());
  const recentGroups = buildRecentGroups(filteredThreads, pinnedSet, groupBy);

  // Collapsed → a thin icon RAIL (nav stays mounted + functional). The logo and
  // the bottom avatar both expand the sidebar; the workspace nav reuses the SAME
  // routes/icons as the full sidebar so nothing drifts.
  if (collapsed) {
    const railItems = SECTIONS.flatMap((section) => section.items);
    return (
      <aside className="app-sidebar collapsed">
        <div className="sidebar-rail">
          <button
            type="button"
            className="sidebar-rail-logo"
            onClick={onToggle}
            title="Expand sidebar"
            aria-label="Expand sidebar"
          >
            <ZintusLogo size="sm" showWordmark={false} />
          </button>

          <button
            type="button"
            className="sidebar-rail-newchat"
            onClick={() => {
              newChat();
              router.push("/chat");
            }}
            title="New chat"
            aria-label="New chat"
          >
            <Icon name="plus" size={18} />
          </button>

          <div className="sidebar-rail-recents" ref={recentsRef}>
            <button
              type="button"
              className="sidebar-rail-item sidebar-rail-recents-trigger"
              onClick={() => setRecentsOpen((v) => !v)}
              title="Recent chats"
              aria-label="Recent chats"
              aria-haspopup="menu"
              aria-expanded={recentsOpen}
            >
              <Icon name="history" size={19} />
            </button>
            {recentsOpen ? (
              <div className="sidebar-rail-recents-panel" role="menu">
                <div className="sidebar-rail-recents-header">
                  <span className="sidebar-rail-recents-label">Recent chats</span>
                  <div className="sidebar-rail-recents-searchrow">
                    <input
                      type="search"
                      className="sidebar-search"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search conversations…"
                    />
                    <div className="sidebar-filter-anchor" ref={filterMenuRef}>
                      <RecentsFilterTrigger
                        active={filtersActive}
                        open={filterMenuOpen}
                        onClick={() => setFilterMenuOpen((v) => !v)}
                      />
                      {filterMenuOpen ? (
                        <RecentsFilterPanel
                          filters={filters}
                          setFilters={setFilters}
                          groupBy={groupBy}
                          setGroupBy={setGroupBy}
                          onReset={resetRecentsFilters}
                        />
                      ) : null}
                    </div>
                  </div>
                </div>
                <div className="sidebar-rail-recents-body">
                  {recentGroups.length === 0 ? (
                    <p className="sidebar-search-empty">
                      {sortedThreads.length === 0 ? (
                        "No chats yet"
                      ) : visibleThreads.length === 0 ? (
                        "No matches"
                      ) : (
                        <>
                          No chats match these filters.{" "}
                          <button
                            type="button"
                            className="sidebar-filter-inline-reset"
                            onClick={resetRecentsFilters}
                          >
                            Reset
                          </button>
                        </>
                      )}
                    </p>
                  ) : (
                    recentGroups.map((group) => (
                      <div key={group.label || "flat"} className="sidebar-thread-group">
                        {group.label ? (
                          <span className="sidebar-thread-group-label">{group.label}</span>
                        ) : null}
                        <div className="sidebar-threads">
                          {group.threads.map((thread) => {
                            const active =
                              thread.id === activeThreadId && pathname === "/chat";
                            return (
                              <button
                                key={thread.id}
                                type="button"
                                role="menuitem"
                                className={`sidebar-thread-button sidebar-rail-recents-row${active ? " active" : ""}`}
                                onClick={() => {
                                  switchThread(thread.id);
                                  router.push("/chat");
                                  setRecentsOpen(false);
                                }}
                              >
                                <span className="sidebar-thread-title">{thread.title}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))
                  )}
                </div>
                <div className="sidebar-rail-recents-footer">
                  <button
                    type="button"
                    className="sidebar-rail-recents-viewall"
                    onClick={() => {
                      onToggle();
                      setRecentsOpen(false);
                    }}
                  >
                    View all →
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <div className="sidebar-rail-divider" />

          <nav className="sidebar-rail-nav">
            {railItems.map((item) => {
              const active = item.href === activeHref;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`sidebar-rail-item${active ? " active" : ""}`}
                  title={item.label}
                  aria-label={item.label}
                >
                  <Icon name={item.icon} size={19} />
                </Link>
              );
            })}
          </nav>

          <div style={{ marginTop: "auto" }} />

          <button
            type="button"
            className="sidebar-rail-avatar"
            onClick={onToggle}
            title="Expand sidebar"
            aria-label="Expand sidebar"
          >
            <span className="sidebar-rail-avatar-initial" aria-hidden>{initial}</span>
            <span
              className={`sidebar-rail-avatar-dot${gatewayConnected ? " online" : ""}`}
              aria-hidden
            />
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className={`app-sidebar${collapsed ? " collapsed" : ""}`}>
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <ZintusLogo size="sm" showWordmark={false} />
        </div>
        <span className="sidebar-brand">Zintus</span>
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
              const active = item.href === activeHref;
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
            <div className="sidebar-section-label-row">
              <span className="sidebar-section-label">Recents</span>
              <div className="sidebar-filter-anchor" ref={filterMenuRef}>
                <RecentsFilterTrigger
                  active={filtersActive}
                  open={filterMenuOpen}
                  onClick={() => setFilterMenuOpen((v) => !v)}
                />
                {filterMenuOpen ? (
                  <RecentsFilterPanel
                    filters={filters}
                    setFilters={setFilters}
                    groupBy={groupBy}
                    setGroupBy={setGroupBy}
                    onReset={resetRecentsFilters}
                  />
                ) : null}
              </div>
            </div>
            <input
              type="search"
              className="sidebar-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search conversations…"
            />
            {recentGroups.length === 0 ? (
              <p className="sidebar-search-empty">
                {visibleThreads.length === 0 ? (
                  "No matches"
                ) : (
                  <>
                    No chats match these filters.{" "}
                    <button
                      type="button"
                      className="sidebar-filter-inline-reset"
                      onClick={resetRecentsFilters}
                    >
                      Reset
                    </button>
                  </>
                )}
              </p>
            ) : null}
            {recentGroups.map((group) => (
              <div key={group.label || "flat"} className="sidebar-thread-group">
                {group.label ? (
                  <span className="sidebar-thread-group-label">{group.label}</span>
                ) : null}
                <div className="sidebar-threads">
                  {group.threads.map((thread) => (
                    <ThreadRow
                      key={thread.id}
                      id={thread.id}
                      title={thread.title}
                      active={thread.id === activeThreadId && pathname === "/chat"}
                      pinned={pinnedSet.has(thread.id)}
                      onTogglePin={() => togglePinThread(thread.id)}
                      onSwitch={() => {
                        switchThread(thread.id);
                        router.push("/chat");
                      }}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </nav>

      {!collapsed ? (
        <div className="sidebar-footer">
          <AccountBlock gatewayConnected={gatewayConnected} />
        </div>
      ) : (
        <div className="sidebar-footer collapsed">
          <Tooltip
            content={gatewayConnected ? "Gateway connected" : "Gateway offline"}
            side="right"
          >
            <span
              className={`status-dot${gatewayConnected ? " online" : ""}`}
              aria-label={gatewayConnected ? "Gateway connected" : "Gateway offline"}
            />
          </Tooltip>
        </div>
      )}
    </aside>
  );
}
