"use client";

import { ZintusLogo } from "@/components/ZintusLogo";

export function Footer() {
  return (
    <footer className="m-footer">
      <div className="m-shell" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "1rem" }}>
        <ZintusLogo size="md" showWordmark />
        <nav style={{ display: "flex", alignItems: "center", gap: "1.25rem" }}>
          <a href="/docs">Docs</a>
          <span style={{ color: "var(--marketing-muted)" }}>Changelog</span>
          <span style={{ color: "var(--marketing-muted)" }}>Security</span>
          <span style={{ color: "var(--marketing-muted)" }}>Contact</span>
        </nav>
        <span>© 2026 Zintus · Business Source License 1.1</span>
      </div>
    </footer>
  );
}
