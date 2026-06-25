import type { Metadata } from "next";
import { PlaceholderPage } from "@/app/_components/PlaceholderPage";

export const metadata: Metadata = { title: "Contact — Zintus" };

export default function ContactPage() {
  return (
    <PlaceholderPage title="Contact">
      <p>
        Questions, feedback, or partnership ideas? Email us at{" "}
        <a href="mailto:hello@zintus.ai" style={{ color: "#c4b5fd" }}>
          hello@zintus.ai
        </a>
        .
      </p>
      <p style={{ marginTop: "1rem" }}>
        For account or billing help, reach{" "}
        <a href="mailto:support@zintus.ai" style={{ color: "#c4b5fd" }}>
          support@zintus.ai
        </a>
        . To report a vulnerability, contact{" "}
        <a href="mailto:security@zintus.ai" style={{ color: "#c4b5fd" }}>
          security@zintus.ai
        </a>
        .
      </p>
    </PlaceholderPage>
  );
}
