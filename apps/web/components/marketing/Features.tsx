// Server Component: pure static markup. The only interactive pieces are the
// <Reveal> / <InteractiveCard> client islands imported below and rendered as
// leaves — keeping this a Server Component means Features' markup, its lucide
// icons, and the catalog-stats data graph all stay off the client bundle.
import { Zap, Key, Shuffle, BarChart2, Terminal } from "lucide-react";
import { Reveal } from "./Reveal";
import { InteractiveCard } from "./InteractiveCard";
import { CATALOG_STATS, floorTo } from "@/data/catalog-stats";

// Derived from data/providers.ts (via catalog-stats), kept in sync with
// ProviderGrid.tsx / Stats.tsx. DIRECT_ROUTABLE is the routable-today count
// (direct + meta + local integrations); AGGREGATOR_PROVIDERS is OpenRouter's
// own published reach (its `specialty` string in providers.ts: "70+ providers
// via single key") — a real number, but not one PROVIDERS.length can compute,
// since those providers aren't individually listed in our catalog.
const DIRECT_ROUTABLE = floorTo(CATALOG_STATS.routableProviders, 10);
const AGGREGATOR_PROVIDERS = 70;
const TOTAL_REACH = floorTo(DIRECT_ROUTABLE + AGGREGATOR_PROVIDERS, 10);

// Four small tiles (icon + copy). The two "importance" features — routing and
// live quota — are the wide bento tiles below with framed mini-UI visuals.
const SMALL_FEATURES = [
  {
    icon: BarChart2,
    color: "#60a5fa",
    title: "No silent downgrades",
    body: "Zintus shows which model handled every request. If your budget runs low we warn you — we never quietly swap what you're getting.",
  },
  {
    icon: Key,
    color: "#2dd4bf",
    title: "Your keys stay on your device",
    body: "BYOK keys live in your OS keychain or the browser's encrypted storage and go straight to the provider. Zintus never sees them.",
  },
  {
    icon: Terminal,
    color: "#38bdf8",
    title: `${TOTAL_REACH}+ providers, one interface`,
    body: `${DIRECT_ROUTABLE}+ direct integrations plus ${AGGREGATOR_PROVIDERS}+ more via a model-aggregator key. One config, one dashboard, one token balance.`,
  },
  {
    icon: Zap,
    color: "#f59e0b",
    title: "BYOK frontier on any plan",
    body: "Add your own key for any frontier model on any paid tier — direct provider rates, zero markup, off your own credits.",
  },
];

// Mini routing visual: request → classify → routed provider (framed mini-UI).
const ROUTES = [
  { model: "gemini-2.0-flash", tag: "long context", color: "#60a5fa", ms: "240ms" },
  { model: "deepseek-v3", tag: "code", color: "#2dd4bf", ms: "180ms" },
  { model: "llama-3.3-70b", tag: "reasoning", color: "#f59e0b", ms: "95ms" },
];

// Mini live-quota visual: fixed monthly token budget, meters that don't shrink.
const METERS = [
  { label: "Starter · 1M tokens", used: "847K left", pct: 84 },
  { label: "Fast models", used: "−1 / 1K", pct: 42 },
  { label: "Advanced models", used: "−5 / 1K", pct: 18 },
];

function RoutingViz() {
  return (
    <div className="bento-viz">
      <div className="bento-viz-prompt">
        <span className="bento-viz-caret">$</span> classify &amp; route request
      </div>
      <div className="bento-viz-routes">
        {ROUTES.map((r) => (
          <div key={r.model} className="bento-viz-route">
            <span className="bento-viz-dot" style={{ background: r.color }} />
            <span className="bento-viz-model">{r.model}</span>
            <span className="bento-viz-tag">{r.tag}</span>
            <span className="bento-viz-ms">{r.ms}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function QuotaViz() {
  return (
    <div className="bento-viz">
      {METERS.map((m) => (
        <div key={m.label} className="bento-viz-meter">
          <div className="bento-viz-meter-head">
            <span>{m.label}</span>
            <span className="bento-viz-meter-val">{m.used}</span>
          </div>
          <div className="bento-viz-track">
            <div className="bento-viz-fill" style={{ width: `${m.pct}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Features() {
  return (
    <section className="m-section m-band m-cv" id="features">
      <div className="m-shell">
        <Reveal>
          <p className="m-eyebrow">Features</p>
          <h2 className="m-title">A router built around what you actually bought.</h2>
          <p className="m-subtitle" style={{ marginBottom: "2.5rem" }}>
            Routing, billing, and key handling are built around one idea: you always
            know which model answered, what it cost, and how much budget is left.
          </p>
        </Reveal>

        <div className="bento-grid">
          {/* Wide tile 1 — smart routing */}
          <Reveal className="bento-span-2">
            <InteractiveCard tilt className="bento-tile bento-tile-wide">
              <div className="bento-tile-head">
                <div className="bento-icon" style={{ background: "#3b82f618" }}>
                  <Shuffle size={20} color="#3b82f6" />
                </div>
                <div>
                  <h3 className="bento-tile-title">Smart routing, real savings</h3>
                  <p className="bento-tile-body">
                    Every request is classified and sent to the best-value provider —
                    short queries to the fastest model, long contexts to the widest
                    window, reasoning to the strongest reasoner.
                  </p>
                </div>
              </div>
              <RoutingViz />
            </InteractiveCard>
          </Reveal>

          {/* Wide tile 2 — exact token balance */}
          <Reveal delay={0.06} className="bento-span-2">
            <InteractiveCard tilt className="bento-tile bento-tile-wide">
              <div className="bento-tile-head">
                <div className="bento-icon" style={{ background: "#eab30818" }}>
                  <BarChart2 size={20} color="#eab308" />
                </div>
                <div>
                  <h3 className="bento-tile-title">Exact token balance</h3>
                  <p className="bento-tile-body">
                    Your monthly budget is a fixed number, shown before you subscribe and
                    after every message. It never shrinks at peak hours or changes with
                    the model you use.
                  </p>
                </div>
              </div>
              <QuotaViz />
            </InteractiveCard>
          </Reveal>

          {/* Four small tiles */}
          {SMALL_FEATURES.map((feature, i) => (
            <Reveal key={feature.title} delay={i * 0.06}>
              <InteractiveCard className="bento-tile">
                <div className="bento-icon" style={{ background: `${feature.color}18` }}>
                  <feature.icon size={20} color={feature.color} />
                </div>
                <h3 className="bento-tile-title">{feature.title}</h3>
                <p className="bento-tile-body">{feature.body}</p>
              </InteractiveCard>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
