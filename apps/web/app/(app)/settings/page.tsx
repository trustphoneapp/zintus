"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { loadMemory, saveMemory } from "@/lib/memory";
import { loadPresets, savePresets, type Preset } from "@/lib/presets";
import { useSettingsStore } from "@/lib/store";
import { ROUTING_STRATEGIES } from "@/lib/settings";
import { PROVIDER_BY_ID, PROVIDERS } from "@/lib/providers";
import { signOut } from "@/lib/cloud";
import { DATA_POLICIES } from "@zintus/providers";
import type { ContextMode, ProviderId, RoutingStrategy } from "@zintus/types";

const TRAINING_PROVIDERS = PROVIDERS.filter(
  (provider) => DATA_POLICIES[provider.id].trainsOnData === true,
);

const CONTEXT_MODES: Array<{
  value: ContextMode;
  label: string;
  description: string;
}> = [
  { value: "fast", label: "Fast", description: "Lowest compile overhead." },
  { value: "smart", label: "Smart", description: "Balanced context quality." },
  { value: "deep", label: "Deep", description: "Most thorough context expansion." },
];

// next-themes is configured with enableSystem={false}, so only explicit themes.
const THEMES: Array<{ value: string; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export default function SettingsPage() {
  const { settings, hydrated, saved, hydrate, update, clearSaved } = useSettingsStore();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [memory, setMemory] = useState<string[]>([]);
  const [memDraft, setMemDraft] = useState("");
  const [presets, setPresets] = useState<Preset[]>([]);
  const [pName, setPName] = useState("");
  const [pProvider, setPProvider] = useState<ProviderId | "">("");
  const [pStrategy, setPStrategy] = useState<RoutingStrategy | "">("");
  const [pSystem, setPSystem] = useState("");
  const [pTemp, setPTemp] = useState("");

  useEffect(() => {
    setMounted(true);
    setMemory(loadMemory());
    setPresets(loadPresets());
  }, []);

  function addPreset() {
    if (!pName.trim()) return;
    const preset: Preset = {
      id: crypto.randomUUID(),
      name: pName.trim(),
      provider: pProvider || undefined,
      strategy: pStrategy || undefined,
      systemPrompt: pSystem.trim() || undefined,
      temperature: pTemp ? Number(pTemp) : undefined,
    };
    const next = [...presets, preset];
    setPresets(next);
    savePresets(next);
    setPName("");
    setPProvider("");
    setPStrategy("");
    setPSystem("");
    setPTemp("");
  }

  function removePreset(id: string) {
    const next = presets.filter((p) => p.id !== id);
    setPresets(next);
    savePresets(next);
  }

  function addMemory() {
    const entry = memDraft.trim();
    if (!entry) return;
    const next = [...memory, entry];
    setMemory(next);
    saveMemory(next);
    setMemDraft("");
  }

  function removeMemory(index: number) {
    const next = memory.filter((_, i) => i !== index);
    setMemory(next);
    saveMemory(next);
  }

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!saved) {
      return;
    }
    const timer = window.setTimeout(() => clearSaved(), 2000);
    return () => window.clearTimeout(timer);
  }, [saved, clearSaved]);

  if (!hydrated) {
    return null;
  }

  const allowed = settings.allowTrainingProviders ?? [];
  const blockedCount = TRAINING_PROVIDERS.filter(
    (provider) => !allowed.includes(provider.id),
  ).length;

  function toggleAllow(id: ProviderId) {
    const next = allowed.includes(id)
      ? allowed.filter((p) => p !== id)
      : [...allowed, id];
    update({ allowTrainingProviders: next });
  }

  return (
    <div className="screen settings-screen">
      <div className="settings-card">
        <h2>Privacy &amp; data</h2>
        <label className="strategy-option" style={{ cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={Boolean(settings.blockTrainingProviders)}
            onChange={(event) =>
              update({ blockTrainingProviders: event.target.checked })
            }
          />
          <span>
            <strong>Block providers that may train on my data</strong>
            <small>
              Routes only to providers that don&apos;t train on your prompts.
              {settings.blockTrainingProviders
                ? ` Filtering ${blockedCount} of ${PROVIDERS.length} providers.`
                : ""}
            </small>
          </span>
        </label>
        {settings.blockTrainingProviders && TRAINING_PROVIDERS.length > 0 ? (
          <div className="privacy-overrides">
            <span className="muted">Allow anyway:</span>
            {TRAINING_PROVIDERS.map((provider) => (
              <label key={provider.id} className="privacy-override">
                <input
                  type="checkbox"
                  checked={allowed.includes(provider.id)}
                  onChange={() => toggleAllow(provider.id)}
                />
                {provider.name}
              </label>
            ))}
          </div>
        ) : null}
      </div>

      <div className="settings-card">
        <h2>Routing strategy</h2>
        <div className="strategy-list">
          {ROUTING_STRATEGIES.map((strategy) => (
            <label key={strategy.value} className="strategy-option">
              <input
                type="radio"
                name="strategy"
                checked={settings.routingStrategy === strategy.value}
                onChange={() =>
                  update({ routingStrategy: strategy.value as RoutingStrategy })
                }
              />
              <span>
                <strong>{strategy.label}</strong>
                <small>{strategy.description}</small>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="settings-card">
        <h2>Default provider</h2>
        <label>
          Preferred provider
          <select
            value={settings.defaultProvider ?? ""}
            onChange={(event) =>
              update({
                defaultProvider: event.target.value
                  ? (event.target.value as ProviderId)
                  : undefined,
              })
            }
          >
            <option value="">Auto (priority queue)</option>
            {PROVIDERS.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="settings-card">
        <h2>Context mode</h2>
        <div className="strategy-list">
          {CONTEXT_MODES.map((mode) => (
            <label key={mode.value} className="strategy-option">
              <input
                type="radio"
                name="context-mode"
                checked={settings.contextMode === mode.value}
                onChange={() => update({ contextMode: mode.value })}
              />
              <span>
                <strong>{mode.label}</strong>
                <small>{mode.description}</small>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="settings-card">
        <h2>Priority order</h2>
        <ol className="priority-list">
          {settings.providerPriority.map((providerId) => (
            <li key={providerId} style={{ color: PROVIDER_BY_ID[providerId].color }}>
              {PROVIDER_BY_ID[providerId].name}
            </li>
          ))}
        </ol>
      </div>

      <div className="settings-card">
        <h2>Memory</h2>
        <p className="muted">
          Stored only in this browser. Injected as background context at the
          start of new chats.
        </p>
        <div className="memory-add">
          <input
            value={memDraft}
            onChange={(event) => setMemDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addMemory();
              }
            }}
            placeholder="e.g. I prefer concise answers in TypeScript"
          />
          <button type="button" onClick={addMemory} disabled={!memDraft.trim()}>
            Add
          </button>
        </div>
        {memory.length > 0 ? (
          <ul className="memory-list">
            {memory.map((entry, index) => (
              <li key={`${entry}-${index}`}>
                <span>{entry}</span>
                <button
                  type="button"
                  aria-label="Delete memory"
                  onClick={() => removeMemory(index)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="settings-card">
        <h2>Appearance</h2>
        <div className="strategy-list">
          {THEMES.map((option) => (
            <label key={option.value} className="strategy-option">
              <input
                type="radio"
                name="theme"
                checked={mounted && theme === option.value}
                onChange={() => setTheme(option.value)}
              />
              <span>
                <strong>{option.label}</strong>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="settings-card">
        <h2>Presets</h2>
        <p className="muted">
          Saved bundles of provider, routing, system prompt, and temperature.
          Apply one from the chat composer. Stored locally.
        </p>
        {presets.length > 0 ? (
          <ul className="memory-list">
            {presets.map((preset) => (
              <li key={preset.id}>
                <span>
                  <strong>{preset.name}</strong>
                  {preset.provider ? ` · ${preset.provider}` : ""}
                  {preset.strategy ? ` · ${preset.strategy}` : ""}
                  {preset.temperature != null ? ` · t=${preset.temperature}` : ""}
                </span>
                <button
                  type="button"
                  aria-label="Delete preset"
                  onClick={() => removePreset(preset.id)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="preset-form">
          <input
            value={pName}
            onChange={(e) => setPName(e.target.value)}
            placeholder="Preset name (e.g. Coding)"
          />
          <div className="preset-form-row">
            <select
              value={pProvider}
              onChange={(e) => setPProvider(e.target.value as ProviderId | "")}
            >
              <option value="">Any provider</option>
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              value={pStrategy}
              onChange={(e) => setPStrategy(e.target.value as RoutingStrategy | "")}
            >
              <option value="">Default routing</option>
              {ROUTING_STRATEGIES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <input
              type="number"
              step="0.1"
              min="0"
              max="2"
              value={pTemp}
              onChange={(e) => setPTemp(e.target.value)}
              placeholder="temp"
              style={{ maxWidth: 90 }}
            />
          </div>
          <textarea
            value={pSystem}
            onChange={(e) => setPSystem(e.target.value)}
            placeholder="System prompt (optional)"
            rows={2}
          />
          <button
            type="button"
            className="memory-add-btn"
            onClick={addPreset}
            disabled={!pName.trim()}
          >
            Add preset
          </button>
        </div>
      </div>

      <div className="settings-card about-card">
        <h2>About</h2>
        <p>Zintus v0.1.0</p>
        <p className="muted">Client-side free-tier orchestrator</p>
        <p className="muted">Run gateway: <code>zintus serve</code></p>
      </div>

      <div className="settings-card">
        <h2>Account</h2>
        <button
          className="auth-submit-btn"
          style={{ background: "var(--color-red)" }}
          onClick={async () => {
            await signOut();
            window.location.href = "/login";
          }}
        >
          Sign out
        </button>
      </div>

      {saved ? <p className="status-banner">Settings saved.</p> : null}
    </div>
  );
}
