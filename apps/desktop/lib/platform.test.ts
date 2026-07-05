import { describe, expect, test } from "bun:test";
import { desktopPlatform, stampPlatform } from "./platform";

describe("desktopPlatform", () => {
  test("classifies the three real webview UAs", () => {
    // WebView2
    expect(
      desktopPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Edg/126"),
    ).toBe("windows");
    // WKWebView
    expect(
      desktopPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15"),
    ).toBe("mac");
    // WebKitGTK
    expect(desktopPlatform("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15")).toBe("linux");
  });

});

describe("stampPlatform", () => {
  test("writes data-platform on the given root", () => {
    const root = { dataset: {} as Record<string, string | undefined> };
    stampPlatform(root, "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    expect(root.dataset["platform"]).toBe("windows");
    stampPlatform(root, "Mozilla/5.0 (X11; Linux x86_64)");
    expect(root.dataset["platform"]).toBe("linux");
  });

  test("never throws without a root (SSR)", () => {
    expect(() => stampPlatform(undefined, "anything")).not.toThrow();
  });
});
