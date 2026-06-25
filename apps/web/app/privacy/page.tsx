import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/app/_components/LegalPage";

export const metadata: Metadata = { title: "Privacy — Zintus" };

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

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" lastUpdated="June 2026 (DRAFT)">
      <p>
        This policy explains, in plain English, what Zintus does and does not collect, why,
        and what choices you have. The short version: on the default BYOK (bring-your-own-key)
        path, your prompts, completions, and API keys never reach Zintus servers. We only
        collect what we need to run an account and bill a paid subscription. Values that must
        be set by counsel are marked <TBD>TBD</TBD> below.
      </p>

      <LegalSection heading="1. Who we are (data controller)">
        <p>
          Zintus is operated by <span style={strong}>YS Ventures LLC</span>, based in
          Pittsburgh, Pennsylvania, USA. For any privacy question or request, contact{" "}
          <a href="mailto:privacy@zintus.ai" style={{ color: "#c4b5fd" }}>
            privacy@zintus.ai
          </a>
          .
        </p>
        <p style={{ marginTop: "0.75rem" }}>
          <span style={strong}>Data Protection Officer / EU representative:</span> Not
          currently appointed. As a small business we believe a DPO is not mandatory, and we
          have not yet appointed an EU/UK representative under GDPR Art. 27.{" "}
          <TBD>To confirm with counsel; appoint if required</TBD>.
        </p>
      </LegalSection>

      <LegalSection heading="2. What we collect">
        <ul style={ulStyle}>
          <li style={liStyle}>
            <span style={strong}>Account email</span> — if you create an account, so we can
            identify you, send sign-in / transactional email, and reach you about your
            subscription.
          </li>
          <li style={liStyle}>
            <span style={strong}>Billing data</span> — handled by our payment processor,
            Stripe. We do not store your full card number; Stripe does. We keep the
            subscription tier, status, and billing-period metadata needed to run your plan.
          </li>
          <li style={liStyle}>
            <span style={strong}>Relay usage metadata / logs</span> — if you use the optional
            cloud relay, we process operational metadata (timestamps, request counts, token
            totals, error states, the provider routed to) to enforce quotas, debug, and
            prevent abuse.
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="3. What we do NOT collect on the BYOK local path">
        <p>
          When you run Zintus locally with your own keys, the local gateway binds to loopback
          (127.0.0.1) by default and talks to AI providers directly. On that path:
        </p>
        <ul style={ulStyle}>
          <li style={liStyle}>
            <span style={strong}>Your prompts and completions</span> never touch Zintus
            servers — they go from your machine straight to the provider.
          </li>
          <li style={liStyle}>
            <span style={strong}>Your API keys</span> stay on your machine — in your OS
            keychain (CLI / desktop / mobile) or encrypted in your browser
            (AES-256-GCM + PBKDF2). We never receive them.
          </li>
        </ul>
        <p style={{ marginTop: "0.75rem" }}>
          When you use the optional cloud relay in BYOK mode, the relay is zero-knowledge: it
          forwards opaque ciphertext and cannot read your keys or your prompts. A
          managed-keys tier (where Zintus would hold provider keys for you) is{" "}
          <span style={strong}>not currently available</span>; it is planned only as a
          possible future option and is described as such throughout this policy.
        </p>
      </LegalSection>

      <LegalSection heading="4. Legal basis for processing (GDPR Art. 6)">
        <p>Where the GDPR applies, we rely on the following legal bases:</p>
        <ul style={ulStyle}>
          <li style={liStyle}>
            <span style={strong}>Account email</span> — performance of a contract (providing
            the account you asked for) and our legitimate interest in account security.
          </li>
          <li style={liStyle}>
            <span style={strong}>Billing data</span> — performance of a contract and
            compliance with legal/tax obligations.
          </li>
          <li style={liStyle}>
            <span style={strong}>Relay usage metadata / logs</span> — our legitimate interest
            in operating, securing, and debugging the service and preventing abuse.
          </li>
          <li style={liStyle}>
            <span style={strong}>Any optional marketing email</span> — your consent, which you
            may withdraw at any time.
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="5. How long we keep things (retention)">
        <ul style={ulStyle}>
          <li style={liStyle}>
            <span style={strong}>Relay usage logs / connection state</span> —{" "}
            <TBD>Retention period — to be finalized by legal; not yet set</TBD>.
          </li>
          <li style={liStyle}>
            <span style={strong}>Account &amp; billing records</span> — kept for the life of
            your account, plus any period required to retain financial records for tax and
            legal compliance after closure:{" "}
            <TBD>Retention period — to be finalized by legal; not yet set</TBD>.
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="6. Your rights (GDPR)">
        <p>If the GDPR applies to you, you have the right to:</p>
        <ul style={ulStyle}>
          <li style={liStyle}>
            <span style={strong}>Access</span> — get a copy of the personal data we hold about
            you;
          </li>
          <li style={liStyle}>
            <span style={strong}>Rectification</span> — correct inaccurate or incomplete data;
          </li>
          <li style={liStyle}>
            <span style={strong}>Erasure</span> — ask us to delete your data (&ldquo;right to
            be forgotten&rdquo;), subject to legal retention requirements;
          </li>
          <li style={liStyle}>
            <span style={strong}>Restriction</span> — ask us to limit how we process your data;
          </li>
          <li style={liStyle}>
            <span style={strong}>Objection</span> — object to processing based on legitimate
            interest;
          </li>
          <li style={liStyle}>
            <span style={strong}>Portability</span> — receive your data in a portable,
            machine-readable format;
          </li>
          <li style={liStyle}>
            <span style={strong}>Withdraw consent</span> — at any time, where we rely on
            consent.
          </li>
        </ul>
        <p style={{ marginTop: "0.75rem" }}>
          To exercise any of these, email{" "}
          <a href="mailto:privacy@zintus.ai" style={{ color: "#c4b5fd" }}>
            privacy@zintus.ai
          </a>
          . You also have the right to{" "}
          <span style={strong}>
            lodge a complaint with your data protection supervisory authority
          </span>{" "}
          (for example, your national or state DPA in the EU/UK).
        </p>
      </LegalSection>

      <LegalSection heading="7. California privacy rights (CCPA / CPRA)">
        <p>
          If you are a California resident, the following applies. In the past 12 months we
          have collected these <span style={strong}>statutory categories</span> of personal
          information:
        </p>
        <ul style={ulStyle}>
          <li style={liStyle}>
            <span style={strong}>Identifiers</span> — account email (and account identifiers).
          </li>
          <li style={liStyle}>
            <span style={strong}>Commercial information</span> — subscription tier and billing
            status (payment card details are processed by Stripe, not stored by us).
          </li>
          <li style={liStyle}>
            <span style={strong}>Internet / network activity</span> — relay usage metadata and
            logs (request counts, timestamps, token totals, error states).
          </li>
        </ul>
        <p style={{ marginTop: "0.75rem" }}>
          <span style={strong}>We do not sell or share your personal information</span>{" "}
          (as &ldquo;sell&rdquo; and &ldquo;share&rdquo; are defined under the CCPA/CPRA), and
          we have not done so in the past 12 months.
        </p>
        <p style={{ marginTop: "0.75rem" }}>
          As a California resident you have the right to{" "}
          <span style={strong}>know, delete, and correct</span> your personal information, to{" "}
          <span style={strong}>opt out</span> of sale/sharing (not applicable, since we do
          neither), and to <span style={strong}>non-discrimination</span> for exercising these
          rights. To make a request, email{" "}
          <a href="mailto:privacy@zintus.ai" style={{ color: "#c4b5fd" }}>
            privacy@zintus.ai
          </a>
          . You may use an authorized agent; we will take reasonable steps to verify your
          identity (and your agent&apos;s authority) before fulfilling a request.
        </p>
      </LegalSection>

      <LegalSection heading="8. Sub-processors">
        <p>We rely on a small set of vendors to operate the service:</p>
        <ul style={ulStyle}>
          <li style={liStyle}>
            <span style={strong}>Cloudflare</span> — edge hosting for the relay and
            key-validation workers. Location: global edge (US and other regions).
          </li>
          <li style={liStyle}>
            <span style={strong}>Stripe</span> — payment processing and subscription billing.
            Location: USA / global.
          </li>
          <li style={liStyle}>
            <span style={strong}>Resend</span> — transactional email (sign-in, billing
            notices). Location: USA / global.
          </li>
          <li style={liStyle}>
            <span style={strong}>Vercel</span> — hosting for this website. Location: USA /
            global.
          </li>
        </ul>
        <p style={{ marginTop: "0.75rem" }}>
          The AI providers you route to (when you supply your own keys) are independent
          services governed by their own privacy terms — see the Terms page.
        </p>
      </LegalSection>

      <LegalSection heading="9. International data transfers">
        <p>
          Our sub-processors (Cloudflare, Stripe, Resend, Vercel) operate in the United States
          and other countries, so using the hosted services may involve transferring personal
          data outside your home country, including to the US. Where required, such transfers
          rely on an appropriate safeguard such as the EU Standard Contractual Clauses (SCCs)
          or an adequacy mechanism:{" "}
          <TBD>
            Transfer mechanism (e.g. SCCs / adequacy) — to confirm with counsel and each
            sub-processor
          </TBD>
          .
        </p>
      </LegalSection>

      <LegalSection heading="10. Changes to this policy">
        <p>
          This is a DRAFT pending legal review. Once finalized, we will notify you of material
          changes (for example by email to your account address or a notice on this page) and
          update the &ldquo;last updated&rdquo; date before the change takes effect. Questions:{" "}
          <a href="mailto:privacy@zintus.ai" style={{ color: "#c4b5fd" }}>
            privacy@zintus.ai
          </a>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
