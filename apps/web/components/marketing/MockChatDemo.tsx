"use client";

import { useEffect, useState } from "react";

interface DemoMessage {
  role: "user" | "assistant";
  text: string;
}

interface DemoTurn {
  user: string;
  routing: string;
  assistant: string;
  provider: string;
  quota: number; // 0..100
  color: string;
}

const TURNS: DemoTurn[] = [
  {
    user: "Explain how neural networks learn",
    routing: "⚡ Routing… cerebras/llama-3.3-70b [12ms]",
    assistant:
      "Neural networks learn through backpropagation — comparing predictions to the truth, then nudging weights to shrink the error, layer by layer.",
    provider: "Cerebras",
    quota: 80,
    color: "#f59e0b",
  },
  {
    user: "Write me a Python function to sort a list",
    routing: "⚡ Quota low → switching to groq [8ms]",
    assistant: "def sort_list(items):\n    return sorted(items)",
    provider: "Groq",
    quota: 100,
    color: "#22c55e",
  },
];

// Phases per turn: 0 show user, 1 show routing, 2 stream assistant, 3 hold.
const PHASE_MS = 1400;
const HOLD_MS = 2600;

export function MockChatDemo() {
  const [turnIndex, setTurnIndex] = useState(0);
  const [phase, setPhase] = useState(0);

  useEffect(() => {
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
  }, [phase, turnIndex]);

  const turn = TURNS[turnIndex]!;
  const messages: DemoMessage[] = [];
  if (phase >= 0) messages.push({ role: "user", text: turn.user });
  if (phase >= 2) messages.push({ role: "assistant", text: turn.assistant });

  return (
    <section style={{ background: "#0a0612", padding: "4rem 0" }}>
      <div className="m-shell">
        <div className="demo-card">
          <div className="demo-card-bar">
            <span className="demo-dot" style={{ background: "#ef4444" }} />
            <span className="demo-dot" style={{ background: "#f59e0b" }} />
            <span className="demo-dot" style={{ background: "#22c55e" }} />
            <span className="demo-card-title">zintus.ai/chat</span>
          </div>

          <div className="demo-card-body">
            {messages.map((m, i) => (
              <div key={`${turnIndex}-${i}`} className={`demo-msg demo-msg-${m.role}`}>
                <div className="demo-bubble">{m.text}</div>
              </div>
            ))}

            {phase === 1 ? (
              <div className="demo-routing">{turn.routing}</div>
            ) : null}
          </div>

          <div className="demo-card-footer">
            <span className="demo-provider">
              <span className="demo-provider-dot" style={{ background: turn.color }} />
              {turn.provider}
            </span>
            <span className="demo-quota">
              <span className="demo-quota-track">
                <span
                  className="demo-quota-fill"
                  style={{ width: `${turn.quota}%`, background: turn.color }}
                />
              </span>
              {turn.quota}% quota
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
