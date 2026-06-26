"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getMe, deleteAccount, signOut, RELAY_URL } from "@/lib/cloud";

type State = "checking" | "signed-out" | "signed-in" | "confirm" | "deleting" | "done" | "error";

/**
 * Interactive part of the public /account/delete page. The page itself is
 * viewable WITHOUT login (Google Play requires the deletion URL to be public),
 * so this widget detects whether the visitor has a Zintus Cloud session and
 * shows either a confirm action (signed in) or a sign-in link (signed out).
 *
 * Deletion is irreversible and the user id is resolved from the session on the
 * relay — this widget sends no id, so it can only ever delete the current user.
 */
export function DeleteAccountWidget() {
  const [state, setState] = useState<State>("checking");
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getMe()
      .then((me) => {
        if (!active) return;
        if (me.authenticated) {
          setEmail(me.email ?? null);
          setState("signed-in");
        } else {
          setState("signed-out");
        }
      })
      .catch(() => active && setState("signed-out"));
    return () => {
      active = false;
    };
  }, []);

  async function handleDelete() {
    setState("deleting");
    const ok = await deleteAccount();
    if (!ok) {
      setState("error");
      return;
    }
    // Best-effort local sign-out, then land on a confirmation.
    await signOut().catch(() => {});
    setState("done");
  }

  const panel: React.CSSProperties = {
    border: "1px solid rgba(148,163,184,0.25)",
    borderRadius: 12,
    padding: "1.5rem",
    background: "rgba(148,163,184,0.05)",
    marginTop: "2rem",
    maxWidth: 760,
  };
  const btn: React.CSSProperties = {
    display: "inline-block",
    padding: "0.7rem 1.25rem",
    borderRadius: 8,
    border: "none",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
  };

  if (state === "checking") {
    return (
      <div style={panel} aria-busy="true">
        <p style={{ color: "#94a3b8", margin: 0 }}>Checking your sign-in status…</p>
      </div>
    );
  }

  if (state === "signed-out") {
    return (
      <div style={panel}>
        <h2 style={{ fontSize: "1.15rem", fontWeight: 700, color: "#e9d5ff", marginTop: 0 }}>
          Delete your Zintus Cloud account
        </h2>
        <p style={{ color: "#94a3b8" }}>
          To delete your account yourself, sign in first — then return here (or use{" "}
          <strong style={{ color: "#cbd5e1" }}>Settings → Account → Delete account</strong> in the
          app) and confirm. We only delete the account of the signed-in user.
        </p>
        <p style={{ marginTop: "1rem" }}>
          <Link
            href="/login"
            style={{ ...btn, background: "#7C3AED", color: "#fff", textDecoration: "none" }}
          >
            Sign in to continue
          </Link>
        </p>
        <p style={{ color: "#64748b", fontSize: 14, marginTop: "1rem", marginBottom: 0 }}>
          Can&apos;t sign in? Email{" "}
          <a href="mailto:support@zintus.ai" style={{ color: "#c4b5fd" }}>
            support@zintus.ai
          </a>{" "}
          from your account address and we&apos;ll delete it for you.
        </p>
      </div>
    );
  }

  if (state === "done") {
    return (
      <div style={panel}>
        <h2 style={{ fontSize: "1.15rem", fontWeight: 700, color: "#86efac", marginTop: 0 }}>
          Account deleted
        </h2>
        <p style={{ color: "#94a3b8", marginBottom: 0 }}>
          Your Zintus Cloud account and associated data have been deleted, and you&apos;ve been
          signed out. Thanks for trying Zintus.
        </p>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div style={panel}>
        <p style={{ color: "#fca5a5", marginTop: 0 }}>
          Something went wrong deleting your account.
        </p>
        <p style={{ color: "#94a3b8", marginBottom: 0 }}>
          Please try again, or email{" "}
          <a href="mailto:support@zintus.ai" style={{ color: "#c4b5fd" }}>
            support@zintus.ai
          </a>{" "}
          and we&apos;ll remove it for you. (Relay: <code>{RELAY_URL}</code>)
        </p>
      </div>
    );
  }

  // signed-in / confirm / deleting
  return (
    <div style={panel}>
      <h2 style={{ fontSize: "1.15rem", fontWeight: 700, color: "#e9d5ff", marginTop: 0 }}>
        Delete your Zintus Cloud account
      </h2>
      <p style={{ color: "#94a3b8" }}>
        Signed in as <strong style={{ color: "#cbd5e1" }}>{email ?? "your account"}</strong>. This
        permanently deletes your account and all the data listed above. This cannot be undone.
      </p>
      {state === "signed-in" ? (
        <button
          type="button"
          style={{ ...btn, background: "#7f1d1d", color: "#fecaca" }}
          onClick={() => setState("confirm")}
        >
          Delete my account
        </button>
      ) : (
        <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
          <button
            type="button"
            style={{ ...btn, background: "#b91c1c", color: "#fff" }}
            onClick={handleDelete}
            disabled={state === "deleting"}
          >
            {state === "deleting" ? "Deleting…" : "Yes, permanently delete"}
          </button>
          <button
            type="button"
            style={{ ...btn, background: "rgba(148,163,184,0.15)", color: "#cbd5e1" }}
            onClick={() => setState("signed-in")}
            disabled={state === "deleting"}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
