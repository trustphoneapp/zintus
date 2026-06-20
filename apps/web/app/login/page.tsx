"use client";

import { useState } from "react";
import { sendMagicLink, googleSignInUrl } from "@/lib/cloud";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const searchParams =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  const isCli = searchParams.get("cli") === "true";
  const isMobile = searchParams.get("mobile") === "true";
  const cliState = searchParams.get("state") ?? undefined;
  const redirectTo = isMobile ? "/api/auth/mobile-redirect" : "/dashboard";

  async function handleMagicLink(event: React.FormEvent) {
    event.preventDefault();
    setStatus("sending");
    const result = await sendMagicLink(email);
    if (result.ok) {
      setStatus("sent");
    } else {
      setErrorMsg(result.error ?? "Something went wrong.");
      setStatus("error");
    }
  }

  function buildGoogleUrl(): string {
    const params = new URLSearchParams({ redirect_to: redirectTo });
    if (isCli && cliState) params.set("state", cliState);
    return `${googleSignInUrl(redirectTo)}&${params.toString()}`;
  }

  if (status === "sent") {
    return (
      <div className="auth-container">
        <h1 className="auth-title">Check your inbox</h1>
        <p className="auth-sub">
          We sent a sign-in link to <strong>{email}</strong>. It expires in 15 minutes.
        </p>
        <button className="auth-link-btn" onClick={() => setStatus("idle")}>
          Use a different email
        </button>
      </div>
    );
  }

  return (
    <div className="auth-container">
      <h1 className="auth-title">Sign in to Zintus</h1>
      {isCli && (
        <p className="auth-badge">CLI login — complete in your browser, then return to the terminal</p>
      )}

      <a href={buildGoogleUrl()} className="auth-google-btn">
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="#4285F4"
            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
          />
          <path
            fill="#34A853"
            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
          />
          <path
            fill="#FBBC05"
            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
          />
          <path
            fill="#EA4335"
            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
          />
        </svg>
        Continue with Google
      </a>

      <div className="auth-divider"><span>or</span></div>

      <form onSubmit={handleMagicLink} className="auth-form">
        <label htmlFor="email">Email address</label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
          disabled={status === "sending"}
          className="auth-input"
          autoComplete="email"
        />
        {status === "error" && (
          <p className="auth-error">{errorMsg}</p>
        )}
        <button
          type="submit"
          disabled={status === "sending" || !email}
          className="auth-submit-btn"
        >
          {status === "sending" ? "Sending…" : "Send magic link"}
        </button>
      </form>

      <p className="auth-footer">
        Free for personal &amp; internal use — no SaaS bill.{" "}
        <a href="/" className="auth-link">Learn more</a>
      </p>
    </div>
  );
}
