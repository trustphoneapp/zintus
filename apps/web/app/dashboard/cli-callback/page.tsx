"use client";

import { useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { createSession, completeCliLogin } from "@/lib/cloud";
import { Suspense } from "react";

function CliCallbackInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const state = searchParams.get("state");
  const [status, setStatus] = useState<"working" | "done" | "error">("working");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    if (!state) {
      setErrorMsg("Missing state parameter.");
      setStatus("error");
      return;
    }

    async function complete() {
      // Create a new gateway session for this CLI login.
      const session = await createSession("CLI Gateway");
      if (!session) {
        setErrorMsg("Failed to create gateway session. Are you signed in?");
        setStatus("error");
        return;
      }

      const ok = await completeCliLogin(
        state!,
        session.session_id,
        session.gateway_secret,
      );

      if (!ok) {
        setErrorMsg("Failed to complete CLI login. The state may have expired.");
        setStatus("error");
        return;
      }

      setStatus("done");
      setTimeout(() => router.push("/dashboard"), 2000);
    }

    void complete();
  }, [state, router]);

  if (status === "working") {
    return (
      <div className="auth-container">
        <h1 className="auth-title">Completing CLI login…</h1>
        <p className="auth-sub">Creating your gateway session.</p>
      </div>
    );
  }

  if (status === "done") {
    return (
      <div className="auth-container">
        <h1 className="auth-title">✓ Logged in</h1>
        <p className="auth-sub">
          Return to your terminal — credentials have been saved to{" "}
          <code>~/.zintus/cloud.json</code>.
        </p>
        <p className="auth-sub">Redirecting to dashboard…</p>
      </div>
    );
  }

  return (
    <div className="auth-container">
      <h1 className="auth-title">Error</h1>
      <p className="auth-sub">{errorMsg}</p>
      <a href="/login" className="auth-link-btn">← Try again</a>
    </div>
  );
}

export default function CliCallbackPage() {
  return (
    <Suspense fallback={<div className="auth-container"><p className="auth-sub">Loading…</p></div>}>
      <CliCallbackInner />
    </Suspense>
  );
}
