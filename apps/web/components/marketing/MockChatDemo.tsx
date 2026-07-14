"use client";

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion";

interface DemoMessage {
  role: "user" | "assistant";
  text: string;
}

interface DemoTurn {
  user: string;
  routing: string;
  assistant: string;
}

const TURNS: DemoTurn[] = [
  {
    user: "Explain how neural networks learn",
    routing: "⚡ Routing… cerebras/llama-3.3-70b [12ms]",
    assistant:
      "Neural networks learn through backpropagation — comparing predictions to the truth, then nudging weights to shrink the error, layer by layer.",
  },
  {
    user: "Write me a Python function to sort a list",
    routing: "⚡ Quota low → switching to groq [8ms]",
    assistant: "def sort_list(items):\n    return sorted(items)",
  },
];

// Static routing rail — this is a marketing demo, not a live gateway feed.
const PROVIDERS = [
  { name: "Cerebras", active: true },
  { name: "Groq", active: false },
  { name: "Gemini", active: false },
];

// Phases per turn: 0 show user, 1 show routing, 2 stream assistant, 3 hold.
const PHASE_MS = 1400;
const HOLD_MS = 2600;

export function MockChatDemo() {
  const reduced = usePrefersReducedMotion();
  const [turnIndex, setTurnIndex] = useState(0);
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    if (reduced) return; // static complete frame, no auto-cycling
    const delay = phase === 3 ? HOLD_MS : PHASE_MS;
    const timer = window.setTimeout(() => {
      if (phase < 3) {
        setPhase((p) => p + 1);
      } else {
        setPhase(0);
        setTurnIndex((t) => (t + 1) % TURNS.length);
      }
    }, delay);
    return () => window.clearTimeout(timer);
  }, [reduced, phase, turnIndex]);

  const turn = TURNS[turnIndex]!;
  // Under reduced motion, hold the first turn fully resolved (phase 3) instead
  // of cycling forever.
  const effectivePhase = reduced ? 3 : phase;
  const messages: DemoMessage[] = [];
  if (effectivePhase >= 0) messages.push({ role: "user", text: turn.user });
  if (effectivePhase >= 2) messages.push({ role: "assistant", text: turn.assistant });

  return (
    <section style={{ background: "var(--marketing-bg)", padding: "5rem 0" }}>
      <div className="m-shell">
        <div className="routing-console">
          {/* LEFT RAIL — routing logic + quota usage (static demo content) */}
          <aside className="routing-rail mk-card">
            <p className="routing-rail-eyebrow">ROUTING LOGIC</p>
            <ul className="routing-provider-list">
              {PROVIDERS.map((p) => (
                <li
                  key={p.name}
                  className={`routing-provider${p.active ? " is-active" : ""}`}
                >
                  <span>{p.name}</span>
                  {p.active ? (
                    <Check size={14} className="routing-provider-check" aria-label="active" />
                  ) : null}
                </li>
              ))}
            </ul>
            <div className="routing-quota">
              <p className="routing-quota-label">QUOTA USAGE</p>
              <div className="routing-quota-bar">
                <span className="routing-quota-fill" style={{ width: "80%" }} />
              </div>
              <p className="routing-quota-caption">80% used · 1.2M tokens remaining</p>
            </div>
          </aside>

          {/* RIGHT — chat demo */}
          <div className="demo-card mk-card">
            <div className="demo-card-bar">
              <span className="demo-dot" style={{ background: "#ef4444" }} />
              <span className="demo-dot" style={{ background: "#f59e0b" }} />
              <span className="demo-dot" style={{ background: "#22c55e" }} />
              <span className="demo-card-title">zintus.ai/chat — 128ms latency</span>
              <span className="routing-badge">
                <span className="routing-badge-dot" />
                ACTIVE
              </span>
            </div>

            <div className="demo-card-body">
              {messages.map((m, i) => (
                <div key={`${turnIndex}-${i}`} className={`demo-msg demo-msg-${m.role}`}>
                  <div className="demo-bubble">{m.text}</div>
                </div>
              ))}

              {effectivePhase === 1 ? <div className="demo-routing">{turn.routing}</div> : null}
            </div>

            {/* Decorative command strip — non-functional. */}
            <div className="demo-command-strip" aria-hidden>
              <span className="demo-command-placeholder">Type a command or query…</span>
              <span className="demo-command-kbd">⌘↵</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
