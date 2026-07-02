import { describe, expect, test } from "bun:test";
import {
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
