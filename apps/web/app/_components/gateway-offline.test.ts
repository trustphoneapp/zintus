import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Guards the /chat offline UX honesty contract (P0): the app surface must funnel
// users to self-host (`zintus serve` + /docs#self-host + /download) and must NOT
// leak internal dev commands (`bun run dev:gateway`, `dev:cli`) to end users.
//
// Zintus is local-first / BYOK — there is no hosted gateway — so the offline copy
// is an onboarding step, not a dev error. See GatewayOfflineBanner.tsx / chat/page.tsx.

const WEB_DIR = join(import.meta.dir, "..", "..");

function read(rel: string): string {
  return readFileSync(join(WEB_DIR, rel), "utf8");
}

// Every user-facing file in the app surface that renders gateway-offline copy.
const APP_SURFACE_FILES = [
  "app/_components/GatewayOfflineBanner.tsx",
  "app/_components/Sidebar.tsx",
  "app/(app)/chat/page.tsx",
  "app/(app)/research/page.tsx",
  "app/(app)/compare/page.tsx",
  "app/(app)/settings/page.tsx",
  "app/(app)/terminal/page.tsx",
  "app/api/chat/route.ts",
  "lib/chat-client.ts",
];

describe("gateway-offline UX honesty", () => {
  it("ships no internal dev-command copy in the app surface", () => {
    for (const file of APP_SURFACE_FILES) {
      const src = read(file);
      expect(src).not.toContain("dev:gateway");
      expect(src).not.toContain("dev:cli");
    }
  });

  it("offline banner funnels to zintus serve + self-host docs + download", () => {
    const src = read("app/_components/GatewayOfflineBanner.tsx");
    expect(src).toContain("zintus serve");
    expect(src).toContain("/docs#self-host");
    expect(src).toContain("/download");
    expect(src.toLowerCase()).toContain("local-first");
  });

  it("distinguishes a reachable gateway that needs authentication", () => {
    const banner = read("app/_components/GatewayOfflineBanner.tsx");
    const shell = read("app/_components/AppShell.tsx");
    expect(banner).toContain("Gateway authentication required.");
    expect(banner).toContain("/engineer#gateway-access");
    expect(shell).toContain("fetchGatewayConnection");
  });

  it("chat empty-state offline panel renders the self-host CTA", () => {
    const src = read("app/(app)/chat/page.tsx");
    expect(src).toContain("zintus serve");
    expect(src).toContain("/docs#self-host");
    expect(src).toContain("/download");
  });
});
