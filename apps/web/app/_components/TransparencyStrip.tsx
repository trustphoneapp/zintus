"use client";

import { useState, type CSSProperties } from "react";
import type { ProviderId } from "@zintus/types";
import { PROVIDER_BY_ID } from "@/lib/providers";
import type { ChatMeta } from "@/lib/gateway";

/** Strip a provider/owner suffix and version noise for a compact model label. */
function shortModel(model: string): string {
  return model.replace(/\s*\(.*\)\s*$/, "").trim();
}

function fmtUsd(value: number): string {
  if (value <= 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

const STRATEGY_LABEL: Record<string, string> = {
  fastest: "Fastest",
  economy: "Economy",
  quality: "Quality",
  weighted: "Weighted",
  auto: "Auto",
};

/** Shared pill styling for the prominent Private-Mode honesty signal. */
const privacyPill = (honored: boolean): CSSProperties => {
  const tone = honored ? "var(--color-green)" : "var(--color-yellow)";
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "1px 8px",
    borderRadius: 999,
    border: `0.5px solid color-mix(in oklch, ${tone} 40%, transparent)`,
    background: `color-mix(in oklch, ${tone} 12%, transparent)`,
    color: tone,
    fontWeight: 600,
  };
};

const PRIVACY_HONORED_TITLE =
  "Private Mode was on and the request was served by a provider with a no-training policy. Your prompt is not used to train models.";
const PRIVACY_BROKEN_TITLE =
  "Private Mode was on, but every available provider may train on data (or has an undocumented policy), so one was used anyway. Add a no-training provider key (e.g. Groq, Cerebras, Mistral) or run Ollama locally.";

/**
 * Per-response proof of the value prop, shown under every assistant message:
 * which provider/model answered, token count, latency, $0 fees, and what the
 * same request would have cost on Claude Sonnet. Click to expand the full trace.
 */
export function TransparencyStrip({ meta }: { meta: ChatMeta }) {
  const [open, setOpen] = useState(false);
  const provider = PROVIDER_BY_ID[meta.provider as ProviderId];
  const color = provider?.color ?? "var(--color-text-sub)";
  const strategy = STRATEGY_LABEL[meta.routingStrategy] ?? meta.routingStrategy;

  return (
    <div className="transparency-strip">
      <button
        type="button"
        className="transparency-summary"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="transparency-dot" style={{ background: color }} />
        <span className="transparency-provider">
          {provider?.name ?? meta.provider}
        </span>
        <span className="transparency-model">{shortModel(meta.model)}</span>
        <span className="transparency-sep">·</span>
        <span>{meta.outputTokens.toLocaleString()} tokens</span>
        <span className="transparency-sep">·</span>
        <span>{meta.latencyMs}ms</span>
        <span className="transparency-sep">·</span>
        <span>$0 fees</span>
        {meta.savedUsd > 0 ? (
          <span className="transparency-saved" title="Estimated savings versus running the same request on Claude Sonnet.">
            ↓ saved ~{fmtUsd(meta.savedUsd)}
          </span>
        ) : null}
        {meta.privacyHonored === true ? (
          <span style={privacyPill(true)} title={PRIVACY_HONORED_TITLE}>
            ✓ Private Mode honored
          </span>
        ) : meta.privacyHonored === false ? (
          <span style={privacyPill(false)} title={PRIVACY_BROKEN_TITLE}>
            ⚠ Private Mode not honored
          </span>
        ) : null}
        <span className="transparency-caret">{open ? "▾ details" : "▸ details"}</span>
      </button>

      {open ? (
        <dl className="transparency-details">
          <dt>Provider</dt>
          <dd>{provider?.name ?? meta.provider}</dd>
          <dt>Model</dt>
          <dd>{meta.model}</dd>
          <dt>Input tokens</dt>
          <dd>{meta.inputTokens.toLocaleString()}</dd>
          <dt>Output tokens</dt>
          <dd>{meta.outputTokens.toLocaleString()}</dd>
          <dt>Total latency</dt>
          <dd>{meta.latencyMs}ms</dd>
          <dt>Cost</dt>
          <dd>{fmtUsd(meta.costUsd)}</dd>
          <dt>Saved vs Claude Sonnet</dt>
          <dd className="transparency-saved">~{fmtUsd(meta.savedUsd)} est</dd>
          <dt>Routing strategy</dt>
          <dd>{strategy}</dd>
          {meta.privacyHonored !== undefined ? (
            <>
              <dt>Private Mode</dt>
              <dd>
                <span style={privacyPill(meta.privacyHonored)}>
                  {meta.privacyHonored
                    ? "✓ Honored — no-training provider"
                    : `⚠ Not honored — used ${provider?.name ?? meta.provider}`}
                </span>
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}
