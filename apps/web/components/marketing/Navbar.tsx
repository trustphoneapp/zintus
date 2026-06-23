"use client";

import { useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { ZintusLogo } from "@/components/ZintusLogo";
import { ThemeToggle } from "./ThemeToggle";

const navItems = [
  { label: "How it works", href: "#how-it-works" },
  { label: "Features", href: "#features" },
  { label: "Supported AIs", href: "#providers" },
  { label: "FAQ", href: "#faq" },
  { label: "Install", href: "#install" },
  { label: "Pricing", href: "/pricing" },
  { label: "Docs", href: "/docs" },
];

export function Navbar() {
  const [open, setOpen] = useState(false);

  return (
    <header className="m-nav-wrap" style={{ backdropFilter: "blur(20px)", background: "rgba(7,4,15,0.8)", borderBottom: "1px solid rgba(124,58,237,0.12)" }}>
      <div className="m-shell m-nav">
        <Link className="m-brand" href="/">
          <ZintusLogo size="sm" showWordmark />
        </Link>
        <nav className="m-nav-links">
          {navItems.map((item) => (
            <a key={item.href} href={item.href}>
              {item.label}
            </a>
          ))}
        </nav>
        <div className="m-nav-actions">
          <Link href="/chat" style={{ background: "#7c3aed", color: "#fff", borderRadius: 8, padding: "7px 16px", fontSize: 13, fontWeight: 600, boxShadow: "0 0 20px rgba(124,58,237,0.4)", textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
            Open app
          </Link>
          <ThemeToggle />
          <button
            type="button"
            className="m-nav-mobile-btn"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <X size={17} /> : <Menu size={17} />}
          </button>
        </div>
      </div>
      {open ? (
        <div className="m-shell m-nav-mobile">
          {navItems.map((item) => (
            <a key={item.href} href={item.href} onClick={() => setOpen(false)}>
              {item.label}
            </a>
          ))}
          <Link href="/chat" onClick={() => setOpen(false)}>
            Open app
          </Link>
        </div>
      ) : null}
    </header>
  );
}
