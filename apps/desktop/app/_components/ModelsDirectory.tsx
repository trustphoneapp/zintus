"use client";

/**
 * Models — the primary provider/model surface (Light.dc design frame 5).
 *
 * Layout: catalog-stats header → search → ZINTUS MEMBERSHIP row (always first:
 * managed models, no keys needed) → "Popular · bring your own key" → "Other",
 * with a bottom-docked connect bar for BYOK key entry and a right slide-over
 * for details (Zintus plans / per-provider model specs).
 *
 * Honesty rules carried from the relay/catalog:
 *  - counts come from the real catalog at runtime, never hardcoded;
 *  - the Zintus panel lists ONLY models the relay can serve right now;
 *  - checkout failures (billing not configured yet) are said out loud.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Search, X } from "lucide-react";
import { ZintusLogo } from "./ZintusLogo";
import type { ProviderId } from "@zintus/types";
import {
  MODEL_CATALOG,
  PROVIDER_METADATA,
  catalogModelsForProvider,
} from "@zintus/providers";
import { validateProviderKey } from "@/lib/gateway";
import { isTauri, openExternal, setKey } from "@/lib/tauri";
import {
  isActiveMember,
  useCloudStore,
  useProviderStatusStore,
} from "@/lib/store";
import {
  PLANS,
  createCheckout,
  createPortalUrl,
  type BillingStatus,
  type ManagedModelInfo,
  type ManagedTier,
} from "@/lib/billing";
import { signOut, startDeviceLogin } from "@/lib/cloud";

const POPULAR: ProviderId[] = [
  "groq",
  "cerebras",
  "ollama",
  "openai",
  "anthropic",
  "gemini",
];
const RECOMMENDED = new Set<ProviderId>(["openai", "anthropic"]);
const LOCAL = new Set<ProviderId>(["ollama", "lmstudio"]);

const sectionLabel: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  color: "var(--color-text-muted)",
  padding: "8px 4px 3px",
};

function initialOf(name: string): string {
  return name.charAt(0).toUpperCase();
}

/** Deterministic soft badge tint per provider from its brand color. */
function avatar(color: string, name: string): ReactNode {
  return (
    <span
      aria-hidden
      style={{
        width: 25,
        height: 25,
        borderRadius: 7,
        flexShrink: 0,
        display: "grid",
        placeItems: "center",
        fontSize: 11,
        fontWeight: 700,
        color,
        background: `color-mix(in srgb, ${color} 14%, var(--color-surface))`,
      }}
    >
      {initialOf(name)}
    </span>
  );
}

export default function ModelsDirectory() {
  const router = useRouter();
  const { providers, refresh, setSelectedProvider, setManagedModel, managedModel } =
    useProviderStatusStore();
  const {
    authenticated,
    email,
    billing,
    managedModels,
    refreshCloud,
  } = useCloudStore();

  const [query, setQuery] = useState("");
  const [dockId, setDockId] = useState<ProviderId | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Right slide-over: "zintus" or a provider id. */
  const [detail, setDetail] = useState<"zintus" | ProviderId | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const dockInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void refresh();
    void refreshCloud();
  }, [refresh, refreshCloud]);

  useEffect(() => {
    if (dockId) dockInputRef.current?.focus();
  }, [dockId]);

  // After checkout opens in the browser, poll billing until the Stripe webhook
  // lands so the plan flips live without a restart. The AppShell focus refresh
  // usually wins the race; this covers the webhook arriving a few seconds after
  // the user tabs back. Stops on activation or after 5 minutes.
  const upgradePollRef = useRef<number | null>(null);
  function pollForUpgrade() {
    if (upgradePollRef.current) window.clearInterval(upgradePollRef.current);
    const startedAt = Date.now();
    upgradePollRef.current = window.setInterval(() => {
      const state = useCloudStore.getState();
      if (isActiveMember(state.billing) || Date.now() - startedAt > 5 * 60_000) {
        if (upgradePollRef.current) window.clearInterval(upgradePollRef.current);
        upgradePollRef.current = null;
        return;
      }
      void state.refreshCloud();
    }, 5_000);
  }
  useEffect(
    () => () => {
      if (upgradePollRef.current) window.clearInterval(upgradePollRef.current);
    },
    [],
  );

  const statusById = useMemo(
    () => new Map(providers.map((p) => [p.id, p])),
    [providers],
  );
  const member = isActiveMember(billing);

  const totalModels = MODEL_CATALOG.length;
  const totalProviders = Object.keys(PROVIDER_METADATA).length;

  const q = query.trim().toLowerCase();
  const matches = (id: ProviderId) => {
    if (!q) return true;
    const meta = PROVIDER_METADATA[id];
    return (
      meta.name.toLowerCase().includes(q) ||
      meta.description.toLowerCase().includes(q) ||
      id.includes(q)
    );
  };
  const zintusMatches = !q || "zintus membership managed".includes(q);

  const allIds = Object.keys(PROVIDER_METADATA) as ProviderId[];
  const popular = POPULAR.filter(matches);
  const other = allIds.filter((id) => !POPULAR.includes(id) && matches(id));

  const isConnected = (id: ProviderId) => {
    const status = statusById.get(id);
    if (!status) return false;
    return LOCAL.has(id) ? status.enabled : status.hasKey;
  };

  function rowClick(id: ProviderId) {
    if (isConnected(id)) {
      setSelectedProvider(id);
      setNotice(`${PROVIDER_METADATA[id].name} set as the chat provider.`);
      router.push("/chat");
      return;
    }
    if (LOCAL.has(id)) {
      setDetail(id); // nothing to connect — show how to start the runtime
      return;
    }
    setKeyDraft("");
    setDockId((current) => (current === id ? null : id));
  }

  async function connectDock(validate: boolean) {
    if (!dockId || !keyDraft.trim()) return;
    const id = dockId;
    const meta = PROVIDER_METADATA[id];
    setBusy(validate ? "validate" : "save");
    try {
      if (validate) {
        const result = await validateProviderKey(id, keyDraft.trim());
        if (!result.ok) {
          setNotice(`Could not test the ${meta.name} key: ${result.error ?? "gateway unreachable"}. Key NOT saved.`);
          return;
        }
        if (!result.valid) {
          setNotice(`${meta.name} rejected that key. Key NOT saved.`);
          return;
        }
      }
      await setKey(id, keyDraft.trim());
      setKeyDraft("");
      setDockId(null);
      await refresh();
      setSelectedProvider(id);
      setNotice(
        validate
          ? `✓ ${meta.name} key validated and saved to your OS keychain.`
          : `${meta.name} key saved to your OS keychain — untested.`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `Failed to save the ${meta.name} key.`);
    } finally {
      setBusy(null);
    }
  }

  async function beginSignIn() {
    setSigningIn(true);
    setNotice(null);
    try {
      const login = await startDeviceLogin();
      if (!login) {
        setNotice("Could not reach the Zintus relay to start sign-in.");
        return;
      }
      await openExternal(login.loginUrl);
      setNotice("Finish signing in from your browser — this page updates automatically.");
      const done = await login.completion;
      if (done) {
        setNotice(`Signed in as ${done.email}.`);
        await refreshCloud();
      } else {
        setNotice("Sign-in was not completed (timed out or cancelled).");
      }
    } finally {
      setSigningIn(false);
    }
  }

  async function upgrade(tier: (typeof PLANS)[number]["tier"]) {
    setBusy(`plan-${tier}`);
    try {
      const result = await createCheckout(tier);
      if (result.ok) {
        await openExternal(result.url);
        setNotice("Complete the checkout in your browser — your plan activates here automatically.");
        pollForUpgrade();
        return;
      }
      if (result.code === "unauthorized") {
        setNotice("Sign in first, then pick a plan.");
        return;
      }
      // billing_not_configured / managed_keys_unavailable / error — say it.
      setNotice(result.message);
    } finally {
      setBusy(null);
    }
  }

  const dockMeta = dockId ? PROVIDER_METADATA[dockId] : null;

  return (
    <div style={{ position: "relative", flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ flex: 1, overflowY: "auto" }}>
        <div
          style={{
            maxWidth: 640,
            margin: "0 auto",
            padding: "20px 24px 8px",
            display: "flex",
            flexDirection: "column",
            gap: 11,
          }}
        >
          <div>
            <h1 style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.01em" }}>Models</h1>
            <p style={{ fontSize: 12.5, lineHeight: 1.5, color: "var(--color-text-sub)" }}>
              {totalModels} models across {totalProviders} providers. Use them with a Zintus
              membership — or bring your own keys; keys stay in your OS keychain.
            </p>
          </div>

          {/* Search */}
          <div style={{ position: "relative" }}>
            <Search
              size={14}
              style={{
                position: "absolute",
                left: 12,
                top: "50%",
                transform: "translateY(-50%)",
                color: "var(--color-text-muted)",
                pointerEvents: "none",
              }}
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search providers…"
              aria-label="Search providers"
              style={{
                width: "100%",
                height: 36,
                padding: "0 12px 0 34px",
                border: "1px solid var(--color-border)",
                borderRadius: 10,
                background: "var(--color-surface)",
                color: "var(--color-text)",
                fontSize: 13.5,
              }}
            />
          </div>

          {notice ? (
            <div
              role="status"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 12px",
                borderRadius: 9,
                background: "var(--color-surface)",
                border: "1px solid var(--color-border)",
                fontSize: 12.5,
                color: "var(--color-text-sub)",
              }}
            >
              <span style={{ flex: 1 }}>{notice}</span>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => setNotice(null)}
                style={{ border: "none", background: "none", color: "var(--color-text-muted)", cursor: "pointer" }}
              >
                <X size={13} />
              </button>
            </div>
          ) : null}

          {/* ── Zintus membership — always first ── */}
          {zintusMatches ? (
            <button
              type="button"
              onClick={() => setDetail("zintus")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 11,
                width: "100%",
                textAlign: "left",
                padding: "10px 10px",
                border: "1px solid color-mix(in srgb, var(--color-purple-bright) 30%, var(--color-border))",
                borderRadius: 10,
                background: "color-mix(in srgb, var(--color-purple-bright) 7%, var(--color-bg))",
                cursor: "pointer",
              }}
            >
              <ZintusLogo size={25} />
              <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text)", flexShrink: 0 }}>
                Zintus
              </span>
              <span
                style={{
                  fontSize: 11.5,
                  color: "var(--color-text-sub)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {managedModels.length > 0
                  ? `${managedModels.length} managed models, no keys needed — from $15/mo`
                  : "Managed models, no keys needed — from $15/mo"}
              </span>
              <span style={{ flex: 1 }} />
              {member && billing ? (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    fontSize: 11,
                    color: "var(--color-green)",
                    fontWeight: 600,
                    flexShrink: 0,
                  }}
                >
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--color-green)" }} />
                  {billing.tier[0]!.toUpperCase() + billing.tier.slice(1)} plan
                </span>
              ) : (
                <span
                  style={{
                    fontSize: 9.5,
                    fontWeight: 600,
                    color: "var(--color-purple-bright)",
                    background: "color-mix(in srgb, var(--color-purple-bright) 14%, transparent)",
                    padding: "2px 7px",
                    borderRadius: 999,
                    flexShrink: 0,
                  }}
                >
                  Recommended · start here
                </span>
              )}
              <ChevronRight size={13} style={{ color: "var(--color-text-muted)", flexShrink: 0 }} />
            </button>
          ) : null}

          {/* ── BYOK sections ── */}
          {popular.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={sectionLabel}>Popular · bring your own key</div>
              {popular.map((id) => (
                <ProviderRow
                  key={id}
                  id={id}
                  connected={isConnected(id)}
                  selected={dockId === id}
                  recommended={RECOMMENDED.has(id)}
                  onClick={() => rowClick(id)}
                  onInfo={() => setDetail(id)}
                />
              ))}
            </div>
          ) : null}

          {other.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={sectionLabel}>Other</div>
              {other.map((id) => (
                <ProviderRow
                  key={id}
                  id={id}
                  connected={isConnected(id)}
                  selected={dockId === id}
                  recommended={false}
                  onClick={() => rowClick(id)}
                  onInfo={() => setDetail(id)}
                />
              ))}
            </div>
          ) : null}

          {popular.length === 0 && other.length === 0 && !zintusMatches ? (
            <div
              style={{
                padding: "28px 16px",
                textAlign: "center",
                color: "var(--color-text-muted)",
                fontSize: 13,
                border: "1px dashed var(--color-border)",
                borderRadius: 12,
              }}
            >
              No providers match your search.
            </div>
          ) : null}
          <div style={{ height: 8 }} />
        </div>
      </div>

      {/* ── Docked connect bar ── */}
      {dockId && dockMeta ? (
        <div
          style={{
            flexShrink: 0,
            borderTop: "1px solid var(--color-border)",
            background: "var(--color-surface)",
            padding: "12px 24px",
          }}
        >
          <div
            style={{
              maxWidth: 640,
              margin: "0 auto",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {avatar(dockMeta.color, dockMeta.name)}
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>Connect {dockMeta.name}</span>
              <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
                · {catalogModelsForProvider(dockId).length} models · key goes to your OS keychain
              </span>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                onClick={() => void openExternal(dockMeta.keyUrl)}
                style={{
                  border: "none",
                  background: "none",
                  color: "var(--color-purple-bright)",
                  fontSize: 11.5,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Get a key ↗
              </button>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setDockId(null)}
                style={{
                  display: "grid",
                  placeItems: "center",
                  width: 22,
                  height: 22,
                  border: "none",
                  borderRadius: 6,
                  background: "transparent",
                  color: "var(--color-text-sub)",
                  cursor: "pointer",
                }}
              >
                <X size={13} />
              </button>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                ref={dockInputRef}
                type="password"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void connectDock(true);
                  if (e.key === "Escape") setDockId(null);
                }}
                placeholder={
                  dockMeta.keyPrefix
                    ? `Paste your ${dockMeta.name} API key (${dockMeta.keyPrefix}…)`
                    : `Paste your ${dockMeta.name} API key`
                }
                aria-label={`${dockMeta.name} API key`}
                style={{
                  flex: 1,
                  height: 34,
                  padding: "0 12px",
                  border: "1px solid var(--color-border)",
                  borderRadius: 9,
                  background: "var(--color-bg)",
                  color: "var(--color-text)",
                  fontSize: 13,
                  fontFamily: "var(--font-mono)",
                }}
              />
              <button
                type="button"
                disabled={!keyDraft.trim() || busy !== null}
                onClick={() => void connectDock(true)}
                style={{
                  height: 34,
                  padding: "0 15px",
                  border: "none",
                  borderRadius: 9,
                  background: "var(--color-primary)",
                  color: "var(--color-primary-contrast)",
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: "pointer",
                  opacity: !keyDraft.trim() || busy !== null ? 0.5 : 1,
                  flexShrink: 0,
                }}
              >
                {busy === "validate" ? "Validating…" : "Validate & add"}
              </button>
              <button
                type="button"
                disabled={!keyDraft.trim() || busy !== null}
                onClick={() => void connectDock(false)}
                title="Save without testing — the key is only checked on first use"
                style={{
                  height: 34,
                  padding: "0 12px",
                  border: "1px solid var(--color-border)",
                  borderRadius: 9,
                  background: "transparent",
                  color: "var(--color-text-sub)",
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: "pointer",
                  opacity: !keyDraft.trim() || busy !== null ? 0.5 : 1,
                  flexShrink: 0,
                }}
              >
                {busy === "save" ? "Saving…" : "Skip test"}
              </button>
            </div>
            {!isTauri() ? (
              <p style={{ fontSize: 11, color: "var(--color-text-muted)", margin: 0 }}>
                Keychain access needs the desktop app — run `bun tauri dev` (browser dev mode
                can browse but not save keys).
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* ── Detail slide-over ── */}
      {detail ? (
        <div
          role="dialog"
          aria-label={detail === "zintus" ? "Zintus membership" : PROVIDER_METADATA[detail].name}
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            width: 360,
            maxWidth: "85%",
            background: "var(--color-surface)",
            borderLeft: "1px solid var(--color-border)",
            boxShadow: "-12px 0 40px -20px rgba(0,0,0,0.35)",
            padding: 18,
            overflowY: "auto",
            zIndex: 30,
          }}
        >
          {detail === "zintus" ? (
            <ZintusPanel
              authenticated={authenticated}
              email={email}
              member={member}
              billing={billing}
              managedModels={managedModels}
              managedModel={managedModel}
              signingIn={signingIn}
              busy={busy}
              onClose={() => setDetail(null)}
              onSignIn={() => void beginSignIn()}
              onSignOut={() => {
                void signOut().then(() => {
                  useCloudStore.getState().resetCloud();
                  setManagedModel(null);
                  setNotice("Signed out of Zintus Cloud.");
                });
              }}
              onUpgrade={(tier) => void upgrade(tier)}
              onManage={() => {
                void createPortalUrl().then((url) => {
                  if (url) void openExternal(url);
                  else setNotice("Could not open the billing portal.");
                });
              }}
              onUseModel={(id) => {
                setManagedModel(id);
                setNotice(`${id} set as the chat model (plan tokens).`);
                router.push("/chat");
              }}
            />
          ) : (
            <ProviderDetail
              id={detail}
              connected={isConnected(detail)}
              onClose={() => setDetail(null)}
              onConnect={() => {
                setDetail(null);
                if (!LOCAL.has(detail)) {
                  setKeyDraft("");
                  setDockId(detail);
                }
              }}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

// ── Provider row ────────────────────────────────────────────────────────────

function ProviderRow(props: {
  id: ProviderId;
  connected: boolean;
  selected: boolean;
  recommended: boolean;
  onClick: () => void;
  onInfo: () => void;
}) {
  const meta = PROVIDER_METADATA[props.id];
  return (
    <div
      className="models-row"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 11,
        width: "100%",
        borderRadius: 9,
        background: props.selected ? "var(--color-surface)" : "transparent",
      }}
    >
      <button
        type="button"
        onClick={props.onClick}
        title={
          props.connected
            ? `Use ${meta.name} in chat`
            : `Connect ${meta.name}`
        }
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          gap: 11,
          textAlign: "left",
          padding: "7px 6px",
          border: "none",
          borderRadius: 9,
          background: "transparent",
          cursor: "pointer",
        }}
      >
        {avatar(meta.color, meta.name)}
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text)", flexShrink: 0 }}>
          {meta.name}
        </span>
        <span
          style={{
            fontSize: 11.5,
            color: "var(--color-text-muted)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {meta.description}
        </span>
        <span style={{ flex: 1 }} />
        {props.recommended && !props.connected ? (
          <span
            style={{
              fontSize: 9.5,
              fontWeight: 600,
              color: "var(--color-text-sub)",
              background: "var(--color-surface)",
              border: "1px solid var(--color-border)",
              padding: "2px 7px",
              borderRadius: 999,
              flexShrink: 0,
            }}
          >
            Recommended
          </span>
        ) : null}
        {props.connected ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              fontSize: 11,
              color: "var(--color-green)",
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--color-green)" }} />
            Connected
          </span>
        ) : null}
      </button>
      <button
        type="button"
        aria-label={`${meta.name} details`}
        title="Models & pricing"
        onClick={props.onInfo}
        className="models-row-info"
        style={{
          flexShrink: 0,
          display: "grid",
          placeItems: "center",
          width: 26,
          height: 26,
          marginRight: 4,
          border: "none",
          borderRadius: 6,
          background: "transparent",
          color: "var(--color-text-muted)",
          cursor: "pointer",
        }}
      >
        <ChevronRight size={14} />
      </button>
    </div>
  );
}

// ── Provider detail panel ───────────────────────────────────────────────────

function ProviderDetail(props: {
  id: ProviderId;
  connected: boolean;
  onClose: () => void;
  onConnect: () => void;
}) {
  const meta = PROVIDER_METADATA[props.id];
  const models = catalogModelsForProvider(props.id);
  const local = LOCAL.has(props.id);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {avatar(meta.color, meta.name)}
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>{meta.name}</h2>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          aria-label="Close"
          onClick={props.onClose}
          style={{
            display: "grid",
            placeItems: "center",
            width: 26,
            height: 26,
            border: "none",
            borderRadius: 6,
            background: "transparent",
            color: "var(--color-text-sub)",
            cursor: "pointer",
          }}
        >
          <X size={14} />
        </button>
      </div>
      <p style={{ fontSize: 12, color: "var(--color-text-sub)", margin: 0, lineHeight: 1.5 }}>
        {meta.description} · {props.connected ? (
          <span style={{ color: "var(--color-green)", fontWeight: 600 }}>connected</span>
        ) : (
          "not connected"
        )}
      </p>
      <p style={{ fontSize: 11, color: "var(--color-text-muted)", margin: 0, lineHeight: 1.5 }}>
        {meta.dataPolicy} {meta.freeTier ? `· Free tier: ${meta.freeTier}` : null}
      </p>
      {models.map((m) => (
        <div
          key={m.id}
          style={{
            border: "1px solid var(--color-border)",
            borderRadius: 10,
            padding: "10px 12px",
            background: "var(--color-bg)",
          }}
        >
          <div style={{ fontSize: 12.5, fontWeight: 600, fontFamily: "var(--font-mono)" }}>
            {m.displayName}
          </div>
          <div
            style={{
              display: "flex",
              gap: 10,
              marginTop: 5,
              fontSize: 10.5,
              color: "var(--color-text-muted)",
              fontFamily: "var(--font-mono)",
              flexWrap: "wrap",
            }}
          >
            <span>ctx {Math.round(m.contextWindow / 1000)}k</span>
            <span>
              {m.local
                ? "local · free"
                : m.inputPer1M != null
                  ? `$${m.inputPer1M} / $${m.outputPer1M} per 1M`
                  : m.free
                    ? "free route"
                    : "price unknown"}
            </span>
          </div>
          <div style={{ display: "flex", gap: 4, marginTop: 6, flexWrap: "wrap" }}>
            {m.vision ? <CapChip label="vision" /> : null}
            {m.tools ? <CapChip label="tools" /> : null}
            {m.structuredOutput !== "none" ? <CapChip label="json" /> : null}
            {m.local ? <CapChip label="on-device" /> : null}
          </div>
        </div>
      ))}
      {models.length === 0 ? (
        <p style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
          No catalog entries for this provider yet.
        </p>
      ) : null}
      {!props.connected && !local ? (
        <button
          type="button"
          onClick={props.onConnect}
          style={{
            height: 34,
            border: "none",
            borderRadius: 9,
            background: "var(--color-primary)",
            color: "var(--color-primary-contrast)",
            fontSize: 12.5,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Connect {meta.name}
        </button>
      ) : null}
      {local && !props.connected ? (
        <p style={{ fontSize: 12, color: "var(--color-text-sub)", lineHeight: 1.5 }}>
          Start {meta.name} on this machine and it appears here automatically — no key needed.
        </p>
      ) : null}
    </div>
  );
}

function CapChip({ label }: { label: string }) {
  return (
    <span
      style={{
        fontSize: 9.5,
        fontWeight: 600,
        padding: "1px 6px",
        borderRadius: 5,
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        color: "var(--color-text-sub)",
      }}
    >
      {label}
    </span>
  );
}

// ── Zintus membership panel ─────────────────────────────────────────────────

function ZintusPanel(props: {
  authenticated: boolean;
  email: string | null;
  member: boolean;
  billing: BillingStatus | null;
  managedModels: ManagedModelInfo[];
  managedModel: string | null;
  signingIn: boolean;
  busy: string | null;
  onClose: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
  onUpgrade: (tier: ManagedTier) => void;
  onManage: () => void;
  onUseModel: (id: string) => void;
}) {
  const { billing } = props;
  const pctUsed =
    billing?.tokens_limit && billing.tokens_limit > 0
      ? Math.min(100, Math.round((billing.tokens_used / billing.tokens_limit) * 100))
      : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <ZintusLogo size={25} />
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>Zintus membership</h2>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          aria-label="Close"
          onClick={props.onClose}
          style={{
            display: "grid",
            placeItems: "center",
            width: 26,
            height: 26,
            border: "none",
            borderRadius: 6,
            background: "transparent",
            color: "var(--color-text-sub)",
            cursor: "pointer",
          }}
        >
          <X size={14} />
        </button>
      </div>

      <p style={{ fontSize: 12, color: "var(--color-text-sub)", margin: 0, lineHeight: 1.55 }}>
        One subscription, every managed model below — no API keys, no per-provider signups.
        Exact token accounting on every reply; your balance is always visible; we never swap
        your model silently.
      </p>

      {/* Account state */}
      {!props.authenticated ? (
        <button
          type="button"
          disabled={props.signingIn}
          onClick={props.onSignIn}
          style={{
            height: 36,
            border: "none",
            borderRadius: 9,
            background: "var(--color-primary)",
            color: "var(--color-primary-contrast)",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            opacity: props.signingIn ? 0.6 : 1,
          }}
        >
          {props.signingIn ? "Waiting for browser sign-in…" : "Sign in with your browser"}
        </button>
      ) : (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            color: "var(--color-text-sub)",
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--color-green)" }} />
          {props.email ?? "Signed in"}
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={props.onSignOut}
            style={{
              border: "none",
              background: "none",
              color: "var(--color-text-muted)",
              fontSize: 11.5,
              cursor: "pointer",
              textDecoration: "underline",
            }}
          >
            Sign out
          </button>
        </div>
      )}

      {/* Plan state */}
      {props.member && billing ? (
        <div
          style={{
            border: "1px solid var(--color-border)",
            borderRadius: 10,
            padding: "10px 12px",
            background: "var(--color-bg)",
          }}
        >
          <div style={{ fontSize: 12.5, fontWeight: 600 }}>
            {billing.tier[0]!.toUpperCase() + billing.tier.slice(1)} plan · active
          </div>
          {billing.tokens_limit ? (
            <>
              <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 4, fontFamily: "var(--font-mono)" }}>
                {(billing.tokens_limit - billing.tokens_used).toLocaleString()} of{" "}
                {billing.tokens_limit.toLocaleString()} tokens left this month
              </div>
              <div style={{ height: 5, borderRadius: 99, background: "var(--color-surface)", marginTop: 8 }}>
                <div
                  style={{
                    height: 5,
                    width: `${pctUsed ?? 0}%`,
                    borderRadius: 99,
                    background: "var(--color-purple-bright)",
                  }}
                />
              </div>
            </>
          ) : null}
          <button
            type="button"
            onClick={props.onManage}
            style={{
              marginTop: 10,
              height: 28,
              padding: "0 10px",
              border: "1px solid var(--color-border)",
              borderRadius: 7,
              background: "transparent",
              color: "var(--color-text-sub)",
              fontSize: 11.5,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Manage billing
          </button>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {PLANS.map((plan) => (
            <button
              key={plan.tier}
              type="button"
              disabled={props.busy === `plan-${plan.tier}`}
              onClick={() => props.onUpgrade(plan.tier)}
              style={{
                textAlign: "left",
                border: "1px solid var(--color-border)",
                borderRadius: 10,
                padding: "10px 12px",
                background: "var(--color-bg)",
                cursor: "pointer",
                opacity: props.busy === `plan-${plan.tier}` ? 0.6 : 1,
              }}
            >
              <div style={{ fontSize: 12.5, fontWeight: 650, color: "var(--color-text)" }}>{plan.name}</div>
              <div style={{ fontSize: 15, fontWeight: 600, marginTop: 2, color: "var(--color-text)" }}>
                ${plan.priceUsd}
                <span style={{ fontSize: 11, fontWeight: 400, color: "var(--color-text-muted)" }}>/mo</span>
              </div>
              <div style={{ fontSize: 10.5, color: "var(--color-text-muted)", marginTop: 2, fontFamily: "var(--font-mono)" }}>
                {(plan.tokensPerMonth / 1_000_000).toLocaleString()}M tokens / month
              </div>
            </button>
          ))}
          <p
            style={{
              gridColumn: "1 / -1",
              fontSize: 11,
              color: "var(--color-text-muted)",
              margin: 0,
              lineHeight: 1.5,
            }}
          >
            Free plan = unlimited BYOK — your own keys, $0, forever.
          </p>
        </div>
      )}

      {/* Managed models — honest list from the relay */}
      <div style={{ ...sectionLabel, padding: "6px 2px 0" }}>
        Included models {props.managedModels.length > 0 ? `· ${props.managedModels.length}` : ""}
      </div>
      {props.managedModels.length === 0 ? (
        <p style={{ fontSize: 12, color: "var(--color-text-muted)", margin: 0, lineHeight: 1.5 }}>
          The managed catalog is empty right now (relay unreachable or no operator keys
          configured yet). BYOK providers below work regardless.
        </p>
      ) : (
        props.managedModels.map((m) => (
          <div
            key={m.id}
            style={{
              border: "1px solid var(--color-border)",
              borderRadius: 10,
              padding: "10px 12px",
              background: "var(--color-bg)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, fontFamily: "var(--font-mono)" }}>
                {m.display_name}
              </span>
              <span style={{ flex: 1 }} />
              {props.member ? (
                <button
                  type="button"
                  onClick={() => props.onUseModel(m.id)}
                  style={{
                    height: 24,
                    padding: "0 9px",
                    border: "none",
                    borderRadius: 6,
                    background:
                      props.managedModel === m.id
                        ? "var(--color-green)"
                        : "var(--color-primary)",
                    color:
                      props.managedModel === m.id
                        ? "#fff"
                        : "var(--color-primary-contrast)",
                    fontSize: 10.5,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {props.managedModel === m.id ? "In use" : "Use in chat"}
                </button>
              ) : null}
            </div>
            <div
              style={{
                display: "flex",
                gap: 10,
                marginTop: 4,
                fontSize: 10.5,
                color: "var(--color-text-muted)",
                fontFamily: "var(--font-mono)",
              }}
            >
              <span>ctx {Math.round(m.context_window / 1000)}k</span>
              <span>plan tokens · {m.multiplier}×</span>
            </div>
          </div>
        ))
      )}
      <p style={{ fontSize: 10.5, color: "var(--color-text-muted)", margin: 0, lineHeight: 1.5 }}>
        Every managed reply shows the exact tokens deducted. All v1 models debit 1:1 — premium
        multipliers will always be shown, never hidden.
      </p>
    </div>
  );
}
