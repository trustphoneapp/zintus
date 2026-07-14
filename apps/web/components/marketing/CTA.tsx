// Server Component: static CTA markup wrapped in the <Reveal> client island.
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Reveal } from "./Reveal";

export function CTA() {
  return (
    <section className="m-section m-cv">
      <div className="m-shell">
        <Reveal>
          <div
            className="mk-card"
            style={{ textAlign: "center", padding: "3.5rem 2rem" }}
          >
            <p className="m-eyebrow" style={{ marginBottom: "1rem" }}>
              Start today
            </p>
              <h2
                style={{
                  fontSize: "clamp(1.8rem, 4vw, 2.8rem)",
                  fontWeight: 800,
                  letterSpacing: "-0.02em",
                  color: "var(--marketing-text)",
                  marginBottom: "1rem",
                }}
              >
                Built for developers who hate paying for AI.
              </h2>
              <p
                style={{
                  color: "var(--marketing-muted)",
                  maxWidth: 480,
                  margin: "0 auto 2rem",
                }}
              >
                All the power. None of the bills. Your keys, your data, your machine.
              </p>
              <div
                style={{
                  display: "flex",
                  gap: 12,
                  justifyContent: "center",
                  flexWrap: "wrap",
                }}
              >
                <Link href="/chat" className="mk-btn mk-btn-primary">
                  Start routing free
                  <ArrowRight size={16} className="mk-btn-arrow" />
                </Link>
                <Link href="/pricing" className="mk-btn mk-btn-secondary">
                  See pricing
                </Link>
              </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
