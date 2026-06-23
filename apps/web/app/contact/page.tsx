import type { Metadata } from "next";
import { PlaceholderPage } from "@/app/_components/PlaceholderPage";

export const metadata: Metadata = { title: "Contact — Zintus" };

export default function ContactPage() {
  return (
    <PlaceholderPage title="Contact">
      <p>
        Questions, feedback, or partnership ideas? Email us at{" "}
        <a href="mailto:yashwanth.surabhi@gmail.com" style={{ color: "#c4b5fd" }}>
          yashwanth.surabhi@gmail.com
        </a>
        .
      </p>
    </PlaceholderPage>
  );
}
