"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Reveal } from "./Reveal";

export function CTA() {
  return (
    <section className="m-section">
      <div className="m-shell">
        <Reveal>
          <div className="m-cta">
            <h2>Ready to try it?</h2>
            <p>
              Open the chat and start asking. It&apos;s free, and you can connect your AI
              services in a couple of minutes.
            </p>
            <div className="m-hero-actions">
              <Link href="/chat" className="m-primary-btn">
                Open the chat
                <ArrowRight size={16} />
              </Link>
              <Link href="/docs" className="m-secondary-btn">
                Read the docs
              </Link>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
