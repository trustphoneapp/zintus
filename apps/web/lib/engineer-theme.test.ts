import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const styles = readFileSync(join(import.meta.dir, "../app/globals.css"), "utf8");
const engineerStyles = styles.slice(
  styles.indexOf("/* Zintus Engineer"),
  styles.indexOf(":root {"),
);

describe("Engineer app-shell integration", () => {
  test("uses the current neutral interaction palette", () => {
    expect(engineerStyles).not.toContain("--c-accent-subtle");
    expect(engineerStyles).not.toMatch(/purple|violet|#[a-f\d]{0,2}(?:6[0-9a-f]|7[0-9a-f])(?:4[0-9a-f]|5[0-9a-f])/i);
    expect(engineerStyles).toContain("--engineer-ink: var(--color-text)");
    expect(engineerStyles).toContain("background: var(--engineer-ink); color: var(--color-bg)");
  });

  test("is exposed in the same workspace navigation as Chat", () => {
    const sidebar = readFileSync(join(import.meta.dir, "../app/_components/Sidebar.tsx"), "utf8");
    expect(sidebar).toContain('{ href: "/chat", icon: "chat", label: "Chat" }');
    expect(sidebar).toContain('{ href: "/engineer", icon: "zap", label: "Engineer" }');
  });
});
