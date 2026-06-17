"use client";

import { useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";

const navItems = [
  { label: "How it works", href: "#how-it-works" },
  { label: "Features", href: "#features" },
  { label: "Supported AIs", href: "#providers" },
  { label: "FAQ", href: "#faq" },
  { label: "Install", href: "#install" },
];

export function Navbar() {
  const [open, setOpen] = useState(false);

  return (
    <header className="m-nav-wrap">
      <div className="m-shell m-nav">
        <Link className="m-brand" href="/">
          <span className="m-brand-mark">M</span>
          <span>MultipleAI</span>
        </Link>
        <nav className="m-nav-links">
          {navItems.map((item) => (
            <a key={item.href} href={item.href}>
              {item.label}
            </a>
          ))}
        </nav>
        <div className="m-nav-actions">
          <Link className="m-ghost-btn" href="/chat">
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
