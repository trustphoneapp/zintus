import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  TEMPLATES,
  getTemplate,
  isValidProjectName,
  scaffold,
} from "./index.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "zintus-scaffold-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("scaffold", () => {
  test("validates project names", () => {
    expect(isValidProjectName("my-app")).toBe(true);
    expect(isValidProjectName("MyApp")).toBe(false);
    expect(isValidProjectName("1app")).toBe(false);
    expect(isValidProjectName("has space")).toBe(false);
  });

  test("every template builds valid JSON package.json and a README", () => {
    for (const t of TEMPLATES) {
      const files = t.build({ name: "demo", deploy: "none" });
      const pkgFile = files.find((f) => f.path === "package.json")!;
      expect(() => JSON.parse(pkgFile.contents)).not.toThrow();
      expect(JSON.parse(pkgFile.contents).name).toBe("demo");
      expect(files.some((f) => f.path === "README.md")).toBe(true);
    }
  });

  test("writes a next-site with a vercel.json when deploy=vercel", () => {
    const parent = tmp();
    const res = scaffold({
      templateId: "next-site",
      name: "my-site",
      parentDir: parent,
      deploy: "vercel",
    });
    expect(res.files).toContain("app/page.tsx");
    expect(res.files).toContain("vercel.json");
    expect(existsSync(path.join(parent, "my-site", "app", "layout.tsx"))).toBe(true);
    const vercel = JSON.parse(
      readFileSync(path.join(parent, "my-site", "vercel.json"), "utf8"),
    );
    expect(vercel.framework).toBe("nextjs");
  });

  test("worker-api emits wrangler.toml only for the cloudflare target", () => {
    const p1 = tmp();
    const cf = scaffold({
      templateId: "worker-api",
      name: "api",
      parentDir: p1,
      deploy: "cloudflare",
    });
    expect(cf.files).toContain("wrangler.toml");
    expect(readFileSync(path.join(p1, "api", "wrangler.toml"), "utf8")).toContain(
      'name = "api"',
    );

    const p2 = tmp();
    const none = scaffold({
      templateId: "worker-api",
      name: "api",
      parentDir: p2,
      deploy: "none",
    });
    expect(none.files).not.toContain("wrangler.toml");
  });

  test("a template ignores an unsupported deploy target (no wrong config)", () => {
    const parent = tmp();
    // next-site does not support cloudflare → no wrangler.toml emitted.
    const res = scaffold({
      templateId: "next-site",
      name: "site",
      parentDir: parent,
      deploy: "cloudflare",
    });
    expect(res.files).not.toContain("wrangler.toml");
  });

  test("refuses an invalid name and an unknown template", () => {
    const parent = tmp();
    expect(() =>
      scaffold({ templateId: "next-site", name: "Bad Name", parentDir: parent }),
    ).toThrow(/Invalid project name/);
    expect(() =>
      scaffold({ templateId: "nope", name: "x", parentDir: parent }),
    ).toThrow(/Unknown template/);
  });

  test("refuses to clobber an existing project", () => {
    const parent = tmp();
    scaffold({ templateId: "worker-api", name: "api", parentDir: parent });
    expect(() =>
      scaffold({ templateId: "worker-api", name: "api", parentDir: parent }),
    ).toThrow(/already looks like a project/);
  });

  test("getTemplate resolves known ids", () => {
    expect(getTemplate("next-site")?.title).toBe("Next.js site");
    expect(getTemplate("missing")).toBeUndefined();
  });
});
