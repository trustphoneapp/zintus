import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/app/_components/LegalPage";

// DRAFT pending legal review — noindex until counsel finalizes it (the page is
// visibly labeled DRAFT). Remove `robots` once the terms are in force.
export const metadata: Metadata = {
  title: "Terms of Service — Zintus",
  robots: { index: false, follow: false },
};

const ulStyle: React.CSSProperties = { margin: "0.5rem 0 0", paddingLeft: "1.25rem" };
const liStyle: React.CSSProperties = { marginBottom: "0.4rem" };
const strong: React.CSSProperties = { color: "#cbd5e1" };
const tbd: React.CSSProperties = {
  color: "#fde68a",
  background: "rgba(234,179,8,0.08)",
  border: "1px solid rgba(234,179,8,0.3)",
  borderRadius: 4,
  padding: "0 4px",
  fontSize: 13,
};

function TBD({ children }: { children: React.ReactNode }) {
  return <span style={tbd}>[{children}]</span>;
}

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" lastUpdated="June 2026 (DRAFT)">
      <p>
        These terms govern your use of Zintus, operated by{" "}
        <span style={strong}>YS Ventures LLC</span> (Pittsburgh, PA). By using the software or
        the hosted services, you agree to them. Plain-English summary below; the final,
        lawyer-reviewed version will replace this DRAFT before public launch. Values that must
        be set by counsel are marked <TBD>TBD</TBD>.
      </p>

      <LegalSection heading="1. What Zintus is">
        <p>Zintus is a local-first, BYOK AI router. It has two main parts:</p>
        <ul style={ulStyle}>
          <li style={liStyle}>
            <span style={strong}>The local router / gateway</span> — runs on your own machine
            (CLI, desktop, or self-hosted gateway), binds to loopback by default, and routes
            your requests across roughly 12 AI providers using your own API keys. Your prompts
            and keys stay on your machine.
          </li>
          <li style={liStyle}>
            <span style={strong}>The optional cloud relay</span> — a hosted service that lets
            remote clients (e.g. mobile) reach your own home gateway over a zero-knowledge,
            ciphertext-only channel. The relay is optional; the core router works entirely
            offline of our servers. A managed-keys tier (routing through Zintus-maintained
            provider accounts) is <span style={strong}>not currently available</span> and is
            only a possible future option.
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="2. Acceptable use">
        <p>You agree not to use Zintus to:</p>
        <ul style={ulStyle}>
          <li style={liStyle}>break the law or infringe others&apos; rights;</li>
          <li style={liStyle}>
            violate the terms, rate limits, or acceptable-use policies of any AI provider you
            route to;
          </li>
          <li style={liStyle}>
            attempt to evade quotas, abuse free tiers in ways the provider prohibits, or
            resell access in violation of a provider&apos;s terms;
          </li>
          <li style={liStyle}>
            attack, overload, or attempt to gain unauthorized access to the relay, workers, or
            other users&apos; gateways.
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="3. BYOK — you are responsible for your providers">
        <p>
          When you bring your own keys, you are the customer of each AI provider (Groq, Gemini,
          OpenRouter, and so on). You are responsible for:
        </p>
        <ul style={ulStyle}>
          <li style={liStyle}>
            complying with each provider&apos;s terms of service and usage policies;
          </li>
          <li style={liStyle}>
            any charges, quota limits, throttling, or account actions those providers impose;
          </li>
          <li style={liStyle}>keeping your own API keys secure.</li>
        </ul>
        <p style={{ marginTop: "0.75rem" }}>
          Zintus does not control provider availability, model behavior, output quality, or
          pricing. The &ldquo;estimated savings&rdquo; figure is a deliberately conservative
          estimate, not a billing guarantee. Quota tracking is per-device; multiple clients
          sharing one provider account can collectively exceed a free-tier limit.
        </p>
      </LegalSection>

      <LegalSection heading="4. Intellectual property, ownership &amp; license">
        <ul style={ulStyle}>
          <li style={liStyle}>
            <span style={strong}>The software</span> is source-available under the Business
            Source License 1.1 (BUSL-1.1). Your use of the code is governed by that license in
            addition to these terms.
          </li>
          <li style={liStyle}>
            <span style={strong}>The service, site, and our marks</span> — the Zintus name,
            logo, and the hosted service remain the property of YS Ventures LLC. These terms do
            not grant you any right to use our trademarks except as needed to use the service.
          </li>
          <li style={liStyle}>
            <span style={strong}>Your content</span> — you retain all rights to the prompts,
            inputs, and outputs you process. We claim no ownership of them. On the BYOK local
            path we never receive your prompts or completions; you grant us only the limited
            license needed to operate any hosted feature you actually use (e.g. routing relay
            traffic you send).
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="5. No SLA on free / Starter tiers">
        <p>
          The free (self-hosted) and Starter tiers are provided{" "}
          <span style={strong}>
            &ldquo;as is&rdquo; with no service-level agreement (SLA)
          </span>{" "}
          and no uptime guarantee. We may change, throttle, suspend, or discontinue the hosted
          relay at any time. If a paid plan reaches its token limit, requests return a clear
          error (HTTP 429) rather than silent overage billing.
        </p>
      </LegalSection>

      <LegalSection heading="6. Termination &amp; suspension">
        <p>
          You may stop using Zintus and close your account at any time. We may suspend or
          terminate your access if you materially breach these terms, abuse the service, or
          create legal/security risk — where practical, with notice and a chance to cure.
        </p>
        <p style={{ marginTop: "0.75rem" }}>
          <span style={strong}>Effect of termination:</span> your right to use the hosted
          services ends; your local, self-hosted software keeps working under the BUSL-1.1
          license; we handle any remaining personal data per the Privacy Policy; and clauses
          that by their nature survive (IP, disclaimers, liability limits, indemnity, governing
          law, dispute resolution) continue to apply.
        </p>
      </LegalSection>

      <LegalSection heading="7. Disclaimer &amp; limitation of liability">
        <p>
          To the maximum extent permitted by law, Zintus and YS Ventures LLC provide the
          software and services <span style={strong}>without warranties of any kind</span>,
          express or implied (including merchantability, fitness for a particular purpose, and
          non-infringement).
        </p>
        <p style={{ marginTop: "0.75rem" }}>
          To the maximum extent permitted by law, we are <span style={strong}>not liable</span>{" "}
          for indirect, incidental, special, consequential, or punitive damages, or for lost
          profits, data, or provider charges, arising from your use of Zintus. Our total
          aggregate liability is limited to the amount you paid us in the 12 months before the
          claim (or, if you paid nothing, USD $0). Some jurisdictions do not allow these limits,
          so parts may not apply to you.
        </p>
      </LegalSection>

      <LegalSection heading="8. Indemnification">
        <p>
          You agree to indemnify and hold harmless YS Ventures LLC and its officers and agents
          from any claims, losses, liabilities, and reasonable expenses (including legal fees)
          arising out of your use of Zintus, your content, your violation of these terms, or
          your violation of any AI provider&apos;s terms or any law or third-party right.
        </p>
      </LegalSection>

      <LegalSection heading="9. Governing law &amp; jurisdiction">
        <p>
          These terms are governed by the laws of the{" "}
          <span style={strong}>Commonwealth of Pennsylvania, USA</span>, without regard to its
          conflict-of-laws rules. Subject to the dispute-resolution section below, you agree to
          the exclusive jurisdiction of the state and federal courts located in{" "}
          <TBD>County/venue, Pennsylvania — to confirm with counsel</TBD>.
        </p>
      </LegalSection>

      <LegalSection heading="10. Dispute resolution &amp; arbitration (with opt-out)">
        <p>
          We hope to resolve any dispute informally first — please email{" "}
          <a href="mailto:privacy@zintus.ai" style={{ color: "#c4b5fd" }}>
            privacy@zintus.ai
          </a>{" "}
          before filing a claim. If we cannot resolve it, disputes will be settled by{" "}
          <span style={strong}>binding individual arbitration</span> (not a class action),
          administered by <TBD>arbitration body &amp; rules — to confirm with counsel</TBD>,
          seated in Pennsylvania.
        </p>
        <p style={{ marginTop: "0.75rem" }}>
          <span style={strong}>30-day opt-out:</span> you may opt out of this arbitration
          agreement by emailing{" "}
          <a href="mailto:privacy@zintus.ai" style={{ color: "#c4b5fd" }}>
            privacy@zintus.ai
          </a>{" "}
          within <span style={strong}>30 days</span> of first accepting these terms; opting out
          does not affect any other part of these terms. Nothing here prevents either party
          from bringing a qualifying claim in small-claims court.
        </p>
      </LegalSection>

      <LegalSection heading="11. Changes &amp; contact">
        <p>
          This is a DRAFT pending legal review. We may update these terms; material changes will
          be posted here with a new date. Questions:{" "}
          <a href="mailto:privacy@zintus.ai" style={{ color: "#c4b5fd" }}>
            privacy@zintus.ai
          </a>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
