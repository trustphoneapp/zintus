"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DATA_FLOW } from "@/lib/consent";
import { setOnboardingComplete } from "@/lib/onboarding";
import { Button } from "./ui/button";

/**
 * First-run orientation overlay. Short by design (desktop users are technical):
 * what Zintus is (BYOK + local gateway), where data travels, and a nudge to add
 * a provider key. Skippable; persists completion in localStorage.
 */
export function OnboardingOverlay({ onDone }: { onDone: () => void }) {
  const router = useRouter();
  const [step, setStep] = useState(0);

  function finish(goProviders?: boolean) {
    setOnboardingComplete();
    onDone();
    if (goProviders) router.push("/providers");
  }

  return (
    <div className="consent-backdrop" role="dialog" aria-modal="true">
      <div className="consent-card" style={{ maxWidth: 540 }}>
        {step === 0 ? (
          <>
            <h2 className="consent-title">Welcome to Zintus</h2>
            <p className="consent-body">
              The AI app that shows you the meter. Bring your own provider keys
              (or local models) for free, or join a Zintus membership and use
              managed models with no keys at all — either way a gateway routes
              every request with privacy and costs you can see.
            </p>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.7, color: "var(--color-text)" }}>
              <li>Your keys stay on this device (OS keyring).</li>
              <li>Membership replies show the exact tokens deducted.</li>
              <li>Every answer shows provider, cost, savings, and quota.</li>
            </ul>
          </>
        ) : step === 1 ? (
          <>
            <h2 className="consent-title">Where your data goes</h2>
            <div className="consent-flow">
              {DATA_FLOW.map((item) => (
                <div key={item.data} className="consent-flow-item">
                  <span className="consent-flow-dest">{item.dest}</span>
                  <span className="consent-flow-data">{item.data}</span>
                  <span className="consent-flow-detail">{item.detail}</span>
                </div>
              ))}
            </div>
            <p className="consent-body" style={{ marginTop: 12, marginBottom: 0 }}>
              You need your own provider key or a local runtime, and the gateway
              must be running. The relay never processes your prompts.
            </p>
          </>
        ) : (
          <>
            <h2 className="consent-title">You&apos;re set</h2>
            <p className="consent-body">
              Start your gateway with <code>zintus serve</code>, then add a
              provider key. Auto Routing then picks the best available free
              provider for each message.
            </p>
          </>
        )}

        <div className="consent-actions">
          <Button type="button" variant="secondary" onClick={() => finish()}>
            Skip
          </Button>
          {step < 2 ? (
            <Button type="button" onClick={() => setStep((s) => s + 1)}>
              Continue
            </Button>
          ) : (
            <Button type="button" onClick={() => finish(true)}>
              Add a provider key →
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
