import Link from "next/link";
import { Navbar } from "@/components/marketing/Navbar";
import { Footer } from "@/components/marketing/Footer";

/**
 * Shared scaffold for the legal / trust pages (privacy, terms, security) so
 * they carry the same header, footer, and DRAFT banner. Content is written in
 * plain English and is NOT a substitute for lawyer-reviewed policy — the banner
 * makes that explicit.
 */
export function LegalPage({
  title,
  lastUpdated,
  children,
}: {
  title: string;
  lastUpdated?: string;
  children: React.ReactNode;
}) {
  return (
    <main className="marketing-page">
      <Navbar />
      <section className="m-shell" style={{ padding: "4rem 0 6rem", minHeight: "60vh" }}>
        {/* DRAFT banner — pending legal review before public launch */}
        <div
          role="note"
          style={{
            border: "1px solid rgba(234,179,8,0.45)",
            background: "rgba(234,179,8,0.08)",
            color: "#fde68a",
            borderRadius: 10,
            padding: "0.85rem 1.1rem",
            fontSize: 14,
            fontWeight: 600,
            marginBottom: "2.5rem",
            maxWidth: 760,
          }}
        >
          ⚠️ DRAFT — pending legal review before public launch
        </div>

        <h1
          style={{
            fontSize: "2.25rem",
            fontWeight: 700,
            marginBottom: lastUpdated ? "0.4rem" : "1.5rem",
            color: "var(--marketing-text)",
          }}
        >
          {title}
        </h1>
        {lastUpdated ? (
          <p style={{ fontSize: 13, color: "var(--marketing-muted)", marginBottom: "2rem" }}>
            Last updated: {lastUpdated}
          </p>
        ) : null}

        <div
          style={{
            fontSize: 15,
            color: "var(--marketing-muted)",
            lineHeight: 1.8,
            maxWidth: 760,
          }}
        >
          {children}
        </div>

        <Link
          href="/"
          style={{
            display: "inline-block",
            marginTop: "3rem",
            fontSize: 14,
            color: "var(--marketing-accent)",
            textDecoration: "none",
          }}
        >
          ← Back to homepage
        </Link>
      </section>
      <Footer />
    </main>
  );
}

/** Section heading used inside legal page bodies. */
export function LegalSection({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginTop: "2.25rem" }}>
      <h2
        style={{
          fontSize: "1.25rem",
          fontWeight: 700,
          color: "var(--marketing-text)",
          marginBottom: "0.75rem",
        }}
      >
        {heading}
      </h2>
      {children}
    </section>
  );
}
