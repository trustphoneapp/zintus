"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  getMe,
  getSessionStatus,
  sendControl,
  createSessionStream,
} from "@/lib/cloud";

interface ProviderStatus {
  id: string;
  name: string;
  remainingRatio?: number;
  requestsLastHour?: number;
}

interface StatusPayload {
  ok?: boolean;
  online?: boolean;
  strategy?: string;
  paused?: boolean;
  providers?: ProviderStatus[];
}

interface RelayEvent {
  event: string;
  data: unknown;
  ts: number;
}

const STRATEGY_OPTIONS = [
  { value: "fastest", label: "Fastest" },
  { value: "economy", label: "Economy" },
  { value: "capability", label: "Capability" },
];

export default function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [events, setEvents] = useState<RelayEvent[]>([]);
  const [offline, setOffline] = useState(false);
  const [strategy, setStrategy] = useState("fastest");
  const [paused, setPaused] = useState(false);
  const [controlling, setControlling] = useState(false);

  const pushEvent = useCallback((event: string, data: unknown) => {
    setEvents((prev) => [{ event, data, ts: Date.now() }, ...prev].slice(0, 10));
    if (event === "gateway_offline") setOffline(true);
    if (event === "gateway_online") setOffline(false);
    if (event === "status") {
      const s = data as StatusPayload;
      if (s.strategy) setStrategy(s.strategy);
      if (typeof s.paused === "boolean") setPaused(s.paused);
      setStatus(s);
      setOffline(false);
    }
  }, []);

  useEffect(() => {
    getMe().then((me) => {
      if (!me.authenticated) router.push("/login");
    });
  }, [router]);

  // Initial status fetch.
  useEffect(() => {
    getSessionStatus(id).then((s) => {
      if (s) {
        const payload = s as StatusPayload;
        setStatus(payload);
        if (payload.strategy) setStrategy(payload.strategy);
        if (typeof payload.paused === "boolean") setPaused(payload.paused);
      } else {
        setOffline(true);
      }
    });
  }, [id]);

  // SSE event stream.
  useEffect(() => {
    const stop = createSessionStream(id, pushEvent);
    return stop;
  }, [id, pushEvent]);

  async function control(action: string, value?: unknown) {
    setControlling(true);
    await sendControl(id, action, value);
    setControlling(false);
  }

  const providers = status?.providers ?? [];

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <button onClick={() => router.push("/dashboard")} className="dashboard-back">
          ← Dashboard
        </button>
        <div className="dashboard-header-right">
          {offline ? (
            <span className="session-badge session-badge--offline">Gateway offline</span>
          ) : (
            <span className="session-badge session-badge--online">● Online</span>
          )}
        </div>
      </header>

      {offline && (
        <div className="session-offline-banner">
          Gateway is offline — open{" "}
          <a href="/dashboard">zintus.app/dashboard</a> for help, or run{" "}
          <code>zintus serve --cloud</code> on the home machine.
        </div>
      )}

      <div className="session-detail-body">
        {/* Strategy */}
        <section className="session-section">
          <h2 className="session-section-title">Routing strategy</h2>
          <div className="session-controls">
            <select
              value={strategy}
              onChange={(e) => {
                setStrategy(e.target.value);
                void control("set_strategy", e.target.value);
              }}
              disabled={controlling || offline}
              className="auth-input"
            >
              {STRATEGY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              onClick={() => {
                const next = !paused;
                setPaused(next);
                void control(next ? "pause" : "resume");
              }}
              disabled={controlling || offline}
              className={`session-btn ${paused ? "session-btn--primary" : "session-btn--danger"}`}
            >
              {paused ? "Resume" : "Pause"}
            </button>
            <button
              onClick={() => control("reload_keys")}
              disabled={controlling || offline}
              className="session-btn"
            >
              Reload keys
            </button>
          </div>
        </section>

        {/* Providers */}
        {providers.length > 0 && (
          <section className="session-section">
            <h2 className="session-section-title">Providers</h2>
            <div className="session-providers">
              {providers.map((p) => {
                const pct = Math.round((p.remainingRatio ?? 0) * 100);
                return (
                  <div key={p.id} className="session-provider-row">
                    <span className="session-provider-name">{p.name}</span>
                    <div className="quota-bar-track">
                      <div
                        className="quota-bar-fill"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="session-provider-pct">{pct}%</span>
                    {p.requestsLastHour != null && (
                      <span className="session-provider-meta">
                        {p.requestsLastHour} req/hr
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        {/* Event feed */}
        <section className="session-section">
          <h2 className="session-section-title">Live events</h2>
          {events.length === 0 ? (
            <p className="session-empty">No events yet.</p>
          ) : (
            <ul className="session-events">
              {events.map((e, i) => (
                <li key={i} className="session-event-row">
                  <span className="session-event-time">
                    {new Date(e.ts).toLocaleTimeString()}
                  </span>
                  <span className="session-event-name">{e.event}</span>
                  <span className="session-event-data">
                    {JSON.stringify(e.data)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
