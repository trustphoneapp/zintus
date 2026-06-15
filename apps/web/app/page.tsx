import Link from "next/link";
import Nav from "./_components/Nav";

const pages = [
  { href: "/chat", label: "Chat", description: "Stream responses across providers." },
  {
    href: "/providers",
    label: "Providers",
    description: "Manage encrypted API keys in your browser vault.",
  },
  {
    href: "/usage",
    label: "Usage",
    description: "Quota overview for configured providers.",
  },
  {
    href: "/settings",
    label: "Settings",
    description: "Routing strategy and defaults.",
  },
];

export default function HomePage() {
  return (
    <>
      <Nav />
      <main>
        <header className="page-header">
          <h1>MultipleAI</h1>
          <p className="page-description">
            Route chat across Cerebras, Groq, Gemini, and more — keys stay encrypted
            in your browser.
          </p>
        </header>

        <div className="card-grid">
          {pages.map((page) => (
            <Link key={page.href} href={page.href} className="card card-link">
              <h2>{page.label}</h2>
              <p>{page.description}</p>
            </Link>
          ))}
        </div>
      </main>
    </>
  );
}
