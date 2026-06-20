"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { fetchGatewayHealth, getGatewayUrl } from "@/lib/gateway";

const NAV = [
  { href: "/chat", label: "Chat" },
  { href: "/terminal", label: "Terminal" },
  { href: "/providers", label: "Providers" },
  { href: "/usage", label: "Usage" },
  { href: "/settings", label: "Settings" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [online, setOnline] = useState(true);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    let active = true;
    async function refresh() {
      const result = await fetchGatewayHealth();
      if (!active) return;
      setOnline(Boolean(result?.health.ok));
      setChecked(true);
    }
    refresh();
    const interval = window.setInterval(refresh, 3000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: "1px solid var(--color-border)",
          background: "var(--color-surface)",
        }}
      >
        <span style={{ fontSize: 20, fontWeight: 700, color: "var(--color-purple-light)" }}>
          Zintus
        </span>
        <nav style={{ display: "flex", gap: 4 }}>
          {NAV.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                style={{
                  padding: "6px 12px",
                  borderRadius: 8,
                  fontSize: 14,
                  color: active ? "var(--color-text)" : "var(--color-text-sub)",
                  background: active ? "var(--color-purple-faint)" : "transparent",
                }}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>
      {checked && !online && (
        <div
          role="status"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 8,
            padding: "8px 16px",
            fontSize: 13,
            background: "var(--color-surface)",
            color: "var(--color-text-sub)",
            borderBottom: "1px solid var(--color-red, #ef4444)",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "var(--color-red, #ef4444)",
            }}
          />
          <span>
            Gateway offline — run{" "}
            <code
              style={{
                padding: "1px 6px",
                borderRadius: 4,
                background: "var(--color-bg, #0b0f14)",
                color: "var(--color-text)",
              }}
            >
              zintus serve
            </code>
          </span>
          <span style={{ color: "var(--color-text-sub)" }}>
            Expecting it at {getGatewayUrl()}
          </span>
        </div>
      )}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {children}
      </div>
    </div>
  );
}
