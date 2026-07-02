import { describe, expect, test } from "bun:test";
import {
  blockedHostReason,
  browserToolDefinition,
  executeBrowseCall,
  type BrowserDriver,
} from "./browser-tool.js";

const fakeDriver: BrowserDriver = {
  async fetchPage(req) {
    return {
      url: req.url,
      finalUrl: req.url,
      title: "Example",
      content: req.extract === "html" ? "<p>hi</p>" : "hi there",
      truncated: false,
    };
  },
};

describe("browser tool (P3)", () => {
  test("definition requires a url", () => {
    expect(browserToolDefinition.name).toBe("browse");
    expect(browserToolDefinition.parameters.required).toContain("url");
  });

  test("refuses honestly when no driver is wired (graceful absence)", async () => {
    const r = await executeBrowseCall(
      { id: "1", arguments: { url: "https://example.com" } },
      undefined,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not available");
  });

  test("rejects a non-http(s) url without touching the driver", async () => {
    let touched = false;
    const driver: BrowserDriver = {
      async fetchPage() {
        touched = true;
        return { url: "", finalUrl: "", title: "" };
      },
    };
    const r = await executeBrowseCall(
      { id: "1", arguments: { url: "file:///etc/passwd" } },
      driver,
    );
    expect(r.isError).toBe(true);
    expect(touched).toBe(false);
  });

  test("returns page content via the driver", async () => {
    const r = await executeBrowseCall(
      { id: "1", arguments: { url: "https://example.com" } },
      fakeDriver,
    );
    expect(r.isError).toBe(false);
    const body = JSON.parse(r.content) as { title: string; content: string };
    expect(body.title).toBe("Example");
    expect(body.content).toBe("hi there");
  });

  describe("SSRF guard (blockedHostReason)", () => {
    test("blocks loopback, private, link-local, and metadata targets", () => {
      for (const h of [
        "localhost",
        "app.local",
        "svc.internal",
        "metadata.google.internal",
        "127.0.0.1",
        "0.0.0.0",
        "10.0.0.5",
        "172.16.9.9",
        "172.31.255.255",
        "192.168.1.1",
        "169.254.169.254", // cloud metadata
        "::1",
        "fe80::1",
        "fd00::1",
        "fc00::1",
      ]) {
        expect(blockedHostReason(h), `${h} should be blocked`).not.toBeNull();
      }
    });

    test("allows ordinary public hosts and public IPs", () => {
      for (const h of ["example.com", "api.openai.com", "8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1"]) {
        expect(blockedHostReason(h), `${h} should be allowed`).toBeNull();
      }
    });
  });

  test("refuses a private URL by default (SSRF), and allows it with allowPrivate", async () => {
    let touched = false;
    const driver: BrowserDriver = {
      async fetchPage() {
        touched = true;
        return { url: "", finalUrl: "", title: "" };
      },
    };
    const blocked = await executeBrowseCall(
      { id: "1", arguments: { url: "http://169.254.169.254/latest/meta-data/" } },
      driver,
    );
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain("SSRF");
    expect(touched).toBe(false);

    const allowed = await executeBrowseCall(
      { id: "2", arguments: { url: "http://127.0.0.1:3000/" } },
      driver,
      { allowPrivate: true },
    );
    expect(allowed.isError).toBe(false);
    expect(touched).toBe(true);
  });

  test("surfaces a driver failure as an honest error, never throws", async () => {
    const boom: BrowserDriver = {
      async fetchPage() {
        throw new Error("navigation failed");
      },
    };
    const r = await executeBrowseCall(
      { id: "1", arguments: { url: "https://example.com" } },
      boom,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("navigation failed");
  });
});
