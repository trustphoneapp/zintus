import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import sitemap from "../app/sitemap";
import robots from "../app/robots";
import { PUBLIC_ROUTES } from "./site";

const APP_DIR = join(import.meta.dir, "..", "app");

describe("sitemap", () => {
  const entries = sitemap();

  it("includes every key public marketing route", () => {
    const paths = entries.map((e) => new URL(e.url).pathname);
    for (const route of ["/", "/pricing", "/docs", "/changelog", "/contact", "/privacy", "/terms", "/security", "/about", "/blog"]) {
      const expected = route === "/" ? "/" : route;
      expect(paths).toContain(expected);
    }
  });

  it("has one entry per PUBLIC_ROUTE with absolute https URLs and priorities", () => {
    expect(entries.length).toBe(PUBLIC_ROUTES.length);
    for (const e of entries) {
      expect(e.url.startsWith("https://")).toBe(true);
      expect(typeof e.priority).toBe("number");
    }
  });

  it("never exposes private/app routes", () => {
    const urls = entries.map((e) => e.url).join(" ");
    for (const bad of ["/dashboard", "/login", "/api/", "/settings", "/usage", "/r/", "/auth/"]) {
      expect(urls.includes(bad)).toBe(false);
    }
  });
});

describe("robots", () => {
  const r = robots();

  it("points at the sitemap and disallows private routes", () => {
    expect(String(r.sitemap)).toContain("/sitemap.xml");
    const rules = Array.isArray(r.rules) ? r.rules : [r.rules];
    const disallow = rules.flatMap((rule) =>
      Array.isArray(rule.disallow) ? rule.disallow : rule.disallow ? [rule.disallow] : [],
    );
    expect(disallow).toContain("/dashboard");
    expect(disallow).toContain("/api/");
  });
});

describe("privacy / no leaked personal email", () => {
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".next") continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (/\.(tsx?|mdx?|txt)$/.test(name)) out.push(full);
    }
    return out;
  }

  it("no page or asset exposes the founder's personal gmail", () => {
    const offenders = walk(APP_DIR)
      .concat(walk(join(import.meta.dir, "..", "public")))
      .filter((f) => readFileSync(f, "utf8").includes("yashwanth.surabhi@gmail.com"));
    expect(offenders).toEqual([]);
  });
});
