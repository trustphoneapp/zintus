import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/app/_components/LegalPage";

// DRAFT pending legal review — noindex until counsel finalizes it (the page is
// visibly labeled DRAFT, same as /privacy and /terms). Remove `robots` once the
// page is in force.
export const metadata: Metadata = {
  title: "Security — Zintus",
  robots: { index: false, follow: false },
};

const ulStyle: React.CSSProperties = { margin: "0.5rem 0 0", paddingLeft: "1.25rem" };
const liStyle: React.CSSProperties = { marginBottom: "0.4rem" };
const strong: React.CSSProperties = { color: "var(--marketing-text)" };
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

export default function SecurityPage() {
  return (
    <LegalPage title="Security" lastUpdated="June 2026 (DRAFT)">
      <p>
        Zintus is built BYOK-first. The most important security property is simple: on the
        default local path, your API keys and prompts stay on your machine and never reach
        Zintus servers. This page explains our threat model honestly — including where the
        guarantees stop.
      </p>

      <LegalSection heading="Threat model: BYOK vs managed keys">
        <p>There are two distinct trust models, and they are not the same:</p>
        <ul style={ulStyle}>
          <li style={liStyle}>
            <span style={strong}>BYOK (the default, recommended path)</span> is zero-knowledge
            with respect to Zintus. Your keys live in your OS keychain (CLI / desktop / mobile)
            or encrypted in your browser, and the local gateway calls providers directly. Even
            when you use the optional cloud relay, it forwards opaque ciphertext encrypted to
            your home gateway&apos;s public key — the relay cannot read your keys or prompts.
          </li>
          <li style={liStyle}>
            <span style={strong}>Managed keys</span> are{" "}
            <span style={strong}>not currently available</span>. The backend for a
            managed-keys tier has been removed and is, at most, a possible future option. If it
            is ever offered, it would <span style={strong}>not</span> be zero-knowledge:
            operator-held keys are operator-decryptable, so anyone with worker-environment
            access could in principle read them. We will document that tradeoff plainly before
            any such tier ships. For now, use BYOK for all keys.
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="BYOK zero-knowledge architecture">
        <ul style={ulStyle}>
          <li style={liStyle}>
            <span style={strong}>
              Local gateway binds to loopback (127.0.0.1) by default
            </span>{" "}
            and refuses to start on a public interface unless a gateway token is set. With a
            token, every endpoint except <code>/health</code> requires a bearer token, compared
            in constant time.
          </li>
          <li style={liStyle}>
            <span style={strong}>Keys at rest</span> — OS keychain on CLI/desktop/mobile; on
            web, AES-256-GCM with a key derived from your passphrase via PBKDF2-HMAC-SHA256 at
            600,000 iterations, stored as ciphertext in <code>localStorage</code>.
          </li>
          <li style={liStyle}>
            <span style={strong}>Relay is ciphertext-only for BYOK</span> — it never holds the
            plaintext key or the key that decrypts it.
          </li>
        </ul>
        <p style={{ marginTop: "0.75rem" }}>
          <span style={strong}>Honest caveat:</span> the web vault is convenience-grade. A
          successful XSS against the web app could exfiltrate the ciphertext, and a weak or
          captured passphrase could then expose keys. For high-value keys, prefer the desktop
          or CLI, which use the OS secure store.
        </p>
      </LegalSection>

      <LegalSection heading="What we have NOT done yet">
        <ul style={ulStyle}>
          <li style={liStyle}>
            <span style={strong}>No SOC 2 (yet).</span> We do not hold SOC 2, ISO 27001, or any
            third-party security certification. We will not claim certifications we do not have.
          </li>
          <li style={liStyle}>
            Quota tracking is per-device; there is no shared global quota ledger.
          </li>
          <li style={liStyle}>
            No multi-tenant authorization, audit logging, or per-key access control on the local
            gateway — it trusts its local keychain and is not a hardened multi-user server.
          </li>
        </ul>
      </LegalSection>

      <LegalSection heading="Reporting a vulnerability">
        <p>
          Found something? Please report it privately rather than opening a public issue. Email{" "}
          <a href="mailto:security@zintus.ai" style={{ color: "var(--marketing-accent)" }}>
            security@zintus.ai
          </a>{" "}
          (or open a private security advisory on the repository). Our machine-readable contact
          details follow RFC 9116 and are published at{" "}
          <a href="/.well-known/security.txt" style={{ color: "var(--marketing-accent)" }}>
            /.well-known/security.txt
          </a>
          .
        </p>
        <p style={{ marginTop: "0.75rem" }}>
          <span style={strong}>Response targets:</span> we aim to acknowledge a report within{" "}
          <TBD>N — e.g. 3</TBD> business days and to give you an initial assessment and remediation
          timeline shortly after. Please give us a reasonable window to investigate and fix
          before public disclosure; we will keep you updated and credit you if you wish.
        </p>
      </LegalSection>

      <LegalSection heading="Safe harbor for good-faith research">
        <p>
          We support good-faith security research. If you make a genuine, good-faith effort to
          comply with this policy during your research, we will:
        </p>
        <ul style={ulStyle}>
          <li style={liStyle}>
            consider it authorized under the Computer Fraud and Abuse Act (and similar laws) and
            will not pursue or support legal action against you for it;
          </li>
          <li style={liStyle}>
            consider it exempt from anti-circumvention claims under the DMCA, and waive any
            relevant restriction in our terms to the extent needed for your research;
          </li>
          <li style={liStyle}>
            work with you to understand and resolve the issue promptly.
          </li>
        </ul>
        <p style={{ marginTop: "0.75rem" }}>
          Good faith means: stay within scope, avoid privacy violations and service disruption,
          do not access or modify data that is not yours beyond what is needed to demonstrate
          the issue, and give us reasonable time to respond before disclosure. If in doubt,
          ask us at{" "}
          <a href="mailto:security@zintus.ai" style={{ color: "var(--marketing-accent)" }}>
            security@zintus.ai
          </a>{" "}
          first. (Adapted from the disclose.io safe-harbor model.)
        </p>
      </LegalSection>

      <LegalSection heading="Full security model">
        <p>
          The complete component-by-component threat model lives in{" "}
          <a
            href="https://github.com/trustphoneapp/zintus/blob/main/SECURITY.md"
            target="_blank"
            rel="noreferrer noopener"
            style={{ color: "var(--marketing-accent)" }}
          >
            SECURITY.md
          </a>{" "}
          in the repository, including trust boundaries, gateway hardening options, and the full
          list of out-of-scope items.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
