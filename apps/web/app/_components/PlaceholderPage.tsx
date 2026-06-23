import Link from "next/link";
import { Navbar } from "@/components/marketing/Navbar";
import { Footer } from "@/components/marketing/Footer";

/**
 * Shared scaffold for simple/stub marketing pages so they carry the same
 * header and footer as the rest of the site.
 */
export function PlaceholderPage({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <main className="marketing-page">
      <Navbar />
      <section className="m-shell" style={{ padding: "6rem 0", minHeight: "50vh" }}>
        <h1
          style={{
            fontSize: "2.25rem",
            fontWeight: 700,
            marginBottom: "1rem",
            color: "#e9d5ff",
          }}
        >
          {title}
        </h1>
        <div style={{ fontSize: 15, color: "#94a3b8", lineHeight: 1.8, maxWidth: 640 }}>
          {children ?? <p>Coming soon — check back shortly.</p>}
        </div>
        <Link
          href="/"
          style={{
            display: "inline-block",
            marginTop: "2rem",
            fontSize: 14,
            color: "#c4b5fd",
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
