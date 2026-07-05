import { describe, expect, test } from "bun:test";
import { PLATFORM_INIT_SCRIPT } from "./platform-init";

describe("PLATFORM_INIT_SCRIPT", () => {
  // The inline script must classify exactly like desktopPlatform()
  // (lib/platform.ts). Execute it against stub UAs to pin the mirror.
  function stamp(userAgent: string): string {
    const doc = { documentElement: { dataset: {} as Record<string, string> } };
    // eslint-disable-next-line no-new-func
    new Function("navigator", "document", PLATFORM_INIT_SCRIPT)({ userAgent }, doc);
    return doc.documentElement.dataset["platform"] ?? "";
  }

  test("classifies the three real webview UAs", () => {
    // WebView2
    expect(
      stamp("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Edg/126"),
    ).toBe("windows");
    // WKWebView
    expect(
      stamp("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15"),
    ).toBe("mac");
    // WebKitGTK
    expect(stamp("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15")).toBe("linux");
  });

  test("never throws — even without navigator", () => {
    const doc = { documentElement: { dataset: {} } };
    expect(() =>
      // eslint-disable-next-line no-new-func
      new Function("navigator", "document", PLATFORM_INIT_SCRIPT)(undefined, doc),
    ).not.toThrow();
  });
});
