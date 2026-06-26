import type { Metadata } from "next";
import Link from "next/link";
import { Navbar } from "@/components/marketing/Navbar";
import { Footer } from "@/components/marketing/Footer";
import { DeleteAccountWidget } from "./DeleteAccountWidget";

// PUBLIC route — must be viewable WITHOUT login. Google Play (and the Apple App
// Store) require a web URL where users can find out how to delete their account
// and data, reachable without signing in. See docs/store/play-listing.md §5.
export const metadata: Metadata = {
  title: "Delete your account — Zintus",
  description:
    "How to delete your Zintus Cloud account and all associated data — self-service or by contacting support.",
};

const ulStyle: React.CSSProperties = { margin: "0.5rem 0 0", paddingLeft: "1.25rem" };
const liStyle: React.CSSProperties = { marginBottom: "0.5rem" };
const strong: React.CSSProperties = { color: "#cbd5e1" };

export default function DeleteAccountPage() {
  return (
    <main className="marketing-page">
      <Navbar />
      <section className="m-shell" style={{ padding: "4rem 0 6rem", minHeight: "60vh" }}>
        <h1
          style={{
            fontSize: "2.25rem",
            fontWeight: 700,
            marginBottom: "0.75rem",
            color: "#e9d5ff",
          }}
        >
          Delete your account
        </h1>

        <div style={{ fontSize: 15, color: "#94a3b8", lineHeight: 1.8, maxWidth: 760 }}>
          <p>
            This page explains how to delete your <span style={strong}>Zintus Cloud</span> account
            and the data associated with it. You can do it yourself, without contacting us. An
            account only exists if you signed in to Zintus Cloud (the optional Remote feature) — if
            you only ever used Zintus in local BYOK mode, there is no Zintus account to delete.
          </p>

          <h2 style={{ fontSize: "1.25rem", fontWeight: 700, color: "#e9d5ff", marginTop: "2.25rem" }}>
            What gets deleted
          </h2>
          <p>When you delete your account, we permanently remove:</p>
          <ul style={ulStyle}>
            <li style={liStyle}>
              <span style={strong}>Your account</span> — your account record and email address.
            </li>
            <li style={liStyle}>
              <span style={strong}>Your sessions</span> — your sign-in sessions and any registered
              home-gateway connections (they are disconnected and removed).
            </li>
            <li style={liStyle}>
              <span style={strong}>Your subscription</span> — your billing record. If you have an
              active paid subscription, we also cancel it (paid/managed-key plans are not currently
              available, so most accounts have none).
            </li>
            <li style={liStyle}>
              <span style={strong}>Your usage &amp; quota</span> — your usage history and your
              monthly quota counter.
            </li>
            <li style={liStyle}>
              <span style={strong}>Referral data</span> — your referral code and referral records.
            </li>
          </ul>

          <h2 style={{ fontSize: "1.25rem", fontWeight: 700, color: "#e9d5ff", marginTop: "2.25rem" }}>
            What we never stored in the first place
          </h2>
          <p>
            Zintus is bring-your-own-key (BYOK). Your <span style={strong}>provider API keys</span>{" "}
            and your <span style={strong}>prompts and AI responses</span> live on your own device
            and on the gateway you run yourself — they are <span style={strong}>not stored by
            Zintus</span>, so there is nothing of that kind for us to delete. When you use the
            optional cloud relay, it forwards opaque encrypted data and cannot read your keys or
            your prompts. To remove your keys, delete them in the app (Providers screen) or on the
            machine running your gateway.
          </p>

          <h2 style={{ fontSize: "1.25rem", fontWeight: 700, color: "#e9d5ff", marginTop: "2.25rem" }}>
            Retention
          </h2>
          <p>
            Deletion is immediate and irreversible. We may retain limited records where required for
            legal, tax, or fraud-prevention reasons (for example, billing records held by our
            payment processor); see our{" "}
            <Link href="/privacy" style={{ color: "#c4b5fd" }}>
              Privacy Policy
            </Link>{" "}
            for details.
          </p>

          <h2 style={{ fontSize: "1.25rem", fontWeight: 700, color: "#e9d5ff", marginTop: "2.25rem" }}>
            How to delete
          </h2>
          <p>You have two self-service options, plus support as a fallback:</p>
          <ul style={ulStyle}>
            <li style={liStyle}>
              <span style={strong}>On this page</span> — sign in below, then confirm. Your account is
              deleted right away.
            </li>
            <li style={liStyle}>
              <span style={strong}>In the app</span> — go to{" "}
              <span style={strong}>Settings → Account → Delete account</span> and confirm.
            </li>
            <li style={liStyle}>
              <span style={strong}>By email</span> — write to{" "}
              <a href="mailto:support@zintus.ai" style={{ color: "#c4b5fd" }}>
                support@zintus.ai
              </a>{" "}
              from your account address and we&apos;ll delete it for you.
            </li>
          </ul>
        </div>

        {/* Interactive confirm / sign-in — works only for YOUR own account. */}
        <DeleteAccountWidget />

        <Link
          href="/"
          style={{
            display: "inline-block",
            marginTop: "3rem",
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
