"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Menu, X, Star } from "lucide-react";

function GithubMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2c-3.2.7-3.88-1.54-3.88-1.54-.53-1.34-1.3-1.7-1.3-1.7-1.06-.72.08-.71.08-.71 1.17.08 1.79 1.2 1.79 1.2 1.04 1.79 2.73 1.27 3.4.97.1-.75.41-1.27.74-1.56-2.55-.29-5.23-1.28-5.23-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11.1 11.1 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.43-2.69 5.41-5.25 5.69.42.36.79 1.07.79 2.16v3.2c0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5z" />
    </svg>
  );
}
import { ZintusLogo } from "@/components/ZintusLogo";
import { ThemeToggle } from "./ThemeToggle";
import { useMagnetic } from "./use-magnetic";

// Section links are root-relative (`/#id`) so they resolve to the homepage
// sections from ANY route. A bare `#id` is a same-document fragment: it works on
// the homepage (which renders those sections) but does nothing on /pricing or
// /docs, where those ids don't exist — that's the navigation-breaks-after-pricing
// bug. `/#id` navigates home and scrolls; on the homepage it just scrolls.
const navItems = [
  { label: "How it works", href: "/#how-it-works" },
  { label: "Features", href: "/#features" },
  { label: "Supported AIs", href: "/#providers" },
  { label: "FAQ", href: "/#faq" },
  { label: "Install", href: "/#install" },
  { label: "Download", href: "/download" },
  { label: "Pricing", href: "/pricing" },
  { label: "Docs", href: "/docs" },
];

export function Navbar() {
  const [open, setOpen] = useState(false);
  const [condensed, setCondensed] = useState(false);
  const openAppMagnetic = useMagnetic<HTMLSpanElement>(4);

  // Scroll-condense: shrink the bar (74→56px) + scale the logo once past 8px.
  // Passive listener; rAF-throttled so scroll stays smooth.
  useEffect(() => {
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(() => {
        setCondensed(window.scrollY > 8);
        ticking = false;
      });
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className={`m-nav-wrap${condensed ? " condensed" : ""}`}>
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
          <a
            href="https://github.com/trustphoneapp/zintus"
            target="_blank"
            rel="noreferrer noopener"
            className="mk-btn mk-btn-secondary mk-btn-sm m-nav-github"
            aria-label="Star Zintus on GitHub"
          >
            <GithubMark />
            <span>Star</span>
            <Star size={12} fill="currentColor" />
          </a>
          <span ref={openAppMagnetic} className="mk-magnetic">
            <Link href="/chat" className="mk-btn mk-btn-primary mk-btn-sm">
              Open app
            </Link>
          </span>
          {/* Far right edge, matching the desktop app's topbar placement. */}
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
          <Link href="/chat" className="mk-btn mk-btn-primary" onClick={() => setOpen(false)}>
            Open app
          </Link>
          <a
            href="https://github.com/trustphoneapp/zintus"
            target="_blank"
            rel="noreferrer noopener"
            className="mk-btn mk-btn-secondary"
          >
            <GithubMark />
            Star on GitHub
          </a>
          <ThemeToggle />
        </div>
      ) : null}
    </header>
  );
}
