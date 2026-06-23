"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Reveal } from "./Reveal";

export function CTA() {
  return (
    <section className="m-section">
      <div className="m-shell">
        <Reveal>
          <div className="gradient-border-card">
            <div
              className="gradient-border-inner"
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
                  color: "#f1f5f9",
                  marginBottom: "1rem",
                }}
              >
                Built for developers who hate paying for AI.
              </h2>
              <p
                style={{
                  color: "#64748b",
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
                <Link
                  href="/chat"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "13px 28px",
                    borderRadius: 10,
                    background: "#7c3aed",
                    color: "#fff",
                    fontSize: 15,
                    fontWeight: 600,
                    textDecoration: "none",
                    boxShadow: "0 0 30px rgba(124,58,237,0.45)",
                  }}
                >
                  Start routing free
                  <ArrowRight size={16} />
                </Link>
                <Link
                  href="/pricing"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "12px 24px",
                    borderRadius: 10,
                    background: "transparent",
                    color: "#94a3b8",
                    fontSize: 15,
                    fontWeight: 500,
                    textDecoration: "none",
                    border: "1px solid rgba(255,255,255,0.1)",
                  }}
                >
                  See pricing
                </Link>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
