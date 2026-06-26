export const runtime = "nodejs";

export async function POST() {
  return new Response(
    [
      "Chat routing runs through your local-first Zintus gateway, not Next.js.",
      "",
      "Start it on your machine:",
      "  zintus serve",
      "",
      "Then add a provider key (it stays on your device):",
      "  zintus keys set groq <your-key>",
      "",
      "Self-host guide: /docs#self-host",
    ].join("\n"),
    {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    },
  );
}
