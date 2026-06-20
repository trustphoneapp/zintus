"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  getMe,
  listSessions,
  createSession,
  deleteSession,
  signOut,
  type GatewaySession,
} from "@/lib/cloud";

function formatLastSeen(ts: number | null): string {
  if (!ts) return "never";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export default function DashboardPage() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [sessions, setSessions] = useState<GatewaySession[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newSession, setNewSession] = useState<{
    session_id: string;
    gateway_secret: string;
  } | null>(null);
  const [newName, setNewName] = useState("My Gateway");
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(async () => {
    const [me, slist] = await Promise.all([getMe(), listSessions()]);
    if (!me.authenticated) {
      router.push("/login");
      return;
    }
    setEmail(me.email ?? null);
    setSessions(slist);
    setLoading(false);
  }, [router]);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(interval);
  }, [refresh]);

  async function handleAddGateway() {
    setAdding(true);
    const result = await createSession(newName);
    setAdding(false);
    if (result) {
      setNewSession(result);
      await refresh();
    }
  }

  async function handleDelete(sessionId: string) {
    if (!confirm("Delete this gateway session? The home machine will be disconnected.")) return;
    await deleteSession(sessionId);
    await refresh();
  }

  async function handleSignOut() {
    await signOut();
    router.push("/login");
  }

  if (loading) {
    return <div className="auth-container"><p className="auth-sub">Loading…</p></div>;
  }

  const setupCommand = newSession
    ? `ZINTUS_SESSION_ID=${newSession.session_id} ZINTUS_GATEWAY_SECRET=${newSession.gateway_secret} zintus serve --cloud`
    : "";

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <h1 className="dashboard-title">Zintus Cloud</h1>
        <div className="dashboard-header-right">
          <span className="dashboard-email">{email}</span>
          <a href="/settings" className="dashboard-nav-link">Settings</a>
          <button onClick={handleSignOut} className="dashboard-signout-btn">
            Sign out
          </button>
        </div>
      </header>

      <div className="dashboard-body">
        {sessions.length === 0 ? (
          <div className="dashboard-empty">
            <p className="dashboard-empty-text">No gateways connected yet.</p>
            <button
              onClick={() => setShowAddModal(true)}
              className="dashboard-add-btn"
            >
              + Add Gateway
            </button>
          </div>
        ) : (
          <>
            <div className="dashboard-sessions">
              {sessions.map((s) => (
                <div key={s.id} className="session-card">
                  <div className="session-card-left">
                    <span
                      className={`session-dot ${s.online ? "session-dot--online" : "session-dot--offline"}`}
                      aria-label={s.online ? "online" : "offline"}
                    />
                    <div>
                      <p className="session-name">{s.name}</p>
                      <p className="session-meta">
                        {s.online ? "Online" : `Last seen ${formatLastSeen(s.last_seen)}`}
                      </p>
                    </div>
                  </div>
                  <div className="session-card-actions">
                    <button
                      onClick={() => router.push(`/dashboard/sessions/${s.id}`)}
                      className="session-btn session-btn--primary"
                    >
                      Connect
                    </button>
                    <button
                      onClick={() => handleDelete(s.id)}
                      className="session-btn session-btn--danger"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <button
              onClick={() => setShowAddModal(true)}
              className="dashboard-add-btn"
            >
              + Add Gateway
            </button>
          </>
        )}
      </div>

      {/* Add gateway modal */}
      {showAddModal && (
        <div className="modal-backdrop" onClick={() => { setShowAddModal(false); setNewSession(null); }}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            {!newSession ? (
              <>
                <h2 className="modal-title">Add Gateway</h2>
                <label className="modal-label">
                  Name
                  <input
                    className="auth-input"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="My Gateway"
                  />
                </label>
                <div className="modal-actions">
                  <button
                    onClick={() => setShowAddModal(false)}
                    className="session-btn"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleAddGateway}
                    disabled={adding}
                    className="session-btn session-btn--primary"
                  >
                    {adding ? "Creating…" : "Create"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2 className="modal-title">Gateway created</h2>
                <p className="modal-sub">
                  Run this on your home machine to connect:
                </p>
                <pre className="modal-code">{setupCommand}</pre>
                <p className="modal-warning">
                  ⚠ Save this command — the secret won&apos;t be shown again.
                </p>
                <div className="modal-actions">
                  <button
                    onClick={() => void navigator.clipboard.writeText(setupCommand)}
                    className="session-btn"
                  >
                    Copy
                  </button>
                  <button
                    onClick={() => { setShowAddModal(false); setNewSession(null); }}
                    className="session-btn session-btn--primary"
                  >
                    Done
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
