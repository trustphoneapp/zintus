import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import sitemap from "../../sitemap";
import { PUBLIC_ROUTES, DISALLOWED_ROUTES } from "../../../lib/site";

// The account-deletion page is a Google Play / App Store requirement: it must be
// PUBLIC (reachable without login) and must clearly state what data is deleted.
// These tests fail if the page stops being public or drops a required disclosure.

const PAGE = join(import.meta.dir, "page.tsx");
const WIDGET = join(import.meta.dir, "DeleteAccountWidget.tsx");

function read(p: string): string {
  return readFileSync(p, "utf8");
}

describe("/account/delete page", () => {
  it("is a PUBLIC route (crawlable, login-free) and in the sitemap", () => {
    expect(PUBLIC_ROUTES).toContain("/account/delete");
    const paths = sitemap().map((e) => new URL(e.url).pathname);
    expect(paths).toContain("/account/delete");
  });

  it("is NOT listed under DISALLOWED (private) route prefixes", () => {
    for (const bad of DISALLOWED_ROUTES) {
      expect("/account/delete".startsWith(bad)).toBe(false);
    }
  });

  it("lists what gets deleted: account, sessions, subscription, usage/quota", () => {
    const src = read(PAGE).toLowerCase();
    expect(src).toContain("what gets deleted");
    expect(src).toContain("account");
    expect(src).toContain("session");
    expect(src).toContain("subscription");
    expect(src).toContain("usage");
    expect(src).toContain("quota");
  });

  it("discloses that BYOK keys live on the user's device/gateway, not stored by Zintus", () => {
    const src = read(PAGE).toLowerCase();
    expect(src).toContain("byok");
    expect(src).toContain("not stored by");
    expect(src).toContain("api key");
  });

  it("explains how to delete: self-service confirm + contact support", () => {
    const src = read(PAGE).toLowerCase();
    expect(src).toContain("how to delete");
    expect(src).toContain("support@zintus.ai");
    // Renders the interactive confirm/sign-in widget.
    expect(read(PAGE)).toContain("<DeleteAccountWidget");
  });

  it("widget deletes only the current user (no id input) via the relay endpoint", () => {
    const src = read(WIDGET);
    expect(src).toContain("deleteAccount");
    // Must NOT accept or send any user id — deletion identity is the session.
    expect(src).not.toMatch(/deleteAccount\([^)]+\)/);
  });
});
