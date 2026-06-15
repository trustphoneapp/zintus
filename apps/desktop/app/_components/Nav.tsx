import Link from "next/link";

const links = [
  { href: "/chat", label: "Chat" },
  { href: "/terminal", label: "Terminal" },
  { href: "/providers", label: "Providers" },
  { href: "/usage", label: "Usage" },
  { href: "/settings", label: "Settings" },
];

export default function Nav({ active }: { active?: string }) {
  return (
    <nav className="nav">
      <Link href="/" className="nav-brand">
        MultipleAI
      </Link>
      <div className="nav-links">
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={active === link.href ? "nav-link active" : "nav-link"}
          >
            {link.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
