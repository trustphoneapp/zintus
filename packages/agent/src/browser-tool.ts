import type { ToolDefinition } from "@zintus/types";
import type { ToolExecutionResult } from "./builtin-tools.js";

/**
 * P3 — an optional browser tool for the agent (Manus Browser-Operator parity
 * where it's cheap). Kept OUT of the core AGENT_TOOLS registry and behind an
 * injectable driver so:
 *   - packages/agent takes NO hard dependency on Playwright (heavy, optional);
 *   - the tool is honestly ABSENT unless a driver is wired, and refuses
 *     clearly rather than pretending;
 *   - it's fully unit-testable with a fake driver.
 *
 * The host (gateway/CLI) opts in by loading a driver (`loadPlaywrightDriver`)
 * and appending `browserToolDefinition` + routing `browse` calls to
 * `executeBrowseCall`. Same trust posture as run_command: off by default,
 * surfaced to the user, and (recommended) confirm-gated by the host.
 */

/** One page action the model can request via the `browse` tool. */
export interface BrowseRequest {
  url: string;
  /** "text" (default) → readable text; "screenshot" → base64 PNG; "html" → raw. */
  extract?: "text" | "screenshot" | "html";
  /** Optional CSS selector to scope text/html extraction. */
  selector?: string;
  /** Max chars of text/html returned (default 8000; screenshots are bytes). */
  maxChars?: number;
}

export interface BrowseResult {
  url: string;
  finalUrl: string;
  title: string;
  /** For extract:"text"|"html" — the (truncated) content. */
  content?: string;
  /** For extract:"screenshot" — base64 PNG (no data: prefix). */
  screenshotBase64?: string;
  truncated?: boolean;
}

/** The minimal browser capability the tool needs — a real Playwright driver or
 *  a fake. Kept tiny so hosts/tests implement it trivially. */
export interface BrowserDriver {
  fetchPage(req: BrowseRequest): Promise<BrowseResult>;
  close?(): Promise<void>;
}

export const browserToolDefinition: ToolDefinition = {
  name: "browse",
  description:
    "Open a URL in a headless browser and return its readable text (default), " +
    "raw HTML, or a screenshot. Use for pages that need JS rendering or for " +
    "visually inspecting a result. Read-only navigation — it does not log in, " +
    "submit forms, or click through flows.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL to open." },
      extract: {
        type: "string",
        enum: ["text", "screenshot", "html"],
        description: "What to return (default text).",
      },
      selector: {
        type: "string",
        description: "Optional CSS selector to scope text/html extraction.",
      },
      maxChars: {
        type: "number",
        description: "Max chars of text/html returned (default 8000).",
      },
    },
    required: ["url"],
  },
};

function err(message: string): string {
  return JSON.stringify({ error: message });
}

/**
 * Execute one `browse` tool call against the wired driver. Returns an honest
 * `isError` result (never throws) when the driver is absent, the URL is not
 * http(s), or the driver fails — so the model can recover.
 */
export async function executeBrowseCall(
  call: { id: string; arguments: Record<string, unknown> },
  driver: BrowserDriver | undefined,
): Promise<ToolExecutionResult> {
  if (!driver) {
    return {
      toolCallId: call.id,
      content: err(
        "browse is not available: no browser driver is configured on this host. " +
          "Install Playwright and start the gateway/CLI with browser support enabled.",
      ),
      isError: true,
    };
  }
  const url = String(call.arguments.url ?? "");
  if (!/^https?:\/\//i.test(url)) {
    return {
      toolCallId: call.id,
      content: err("url must be an absolute http(s) URL."),
      isError: true,
    };
  }
  const extractRaw = call.arguments.extract;
  const extract =
    extractRaw === "screenshot" || extractRaw === "html" ? extractRaw : "text";
  const maxChars =
    typeof call.arguments.maxChars === "number" && call.arguments.maxChars > 0
      ? Math.min(call.arguments.maxChars, 50_000)
      : 8000;
  try {
    const result = await driver.fetchPage({
      url,
      extract,
      selector:
        typeof call.arguments.selector === "string"
          ? call.arguments.selector
          : undefined,
      maxChars,
    });
    return { toolCallId: call.id, content: JSON.stringify(result), isError: false };
  } catch (error) {
    return {
      toolCallId: call.id,
      content: err(error instanceof Error ? error.message : String(error)),
      isError: true,
    };
  }
}

/**
 * Best-effort Playwright driver loader. Dynamically imports `playwright` so the
 * package is NOT a build/runtime dependency; returns `null` (with no throw)
 * when it isn't installed, so the host can fall back to "browse unavailable".
 */
export async function loadPlaywrightDriver(opts?: {
  /** navigation timeout ms (default 30s). */
  timeoutMs?: number;
}): Promise<BrowserDriver | null> {
  let chromium: {
    launch(o?: unknown): Promise<unknown>;
  };
  try {
    // Indirect specifier so TypeScript doesn't resolve the (optional,
    // uninstalled) module at build time — playwright is NOT a dependency of
    // this package; the host installs it only if it wants browser support.
    const spec = "playwright";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ({ chromium } = (await import(spec)) as any);
  } catch {
    return null;
  }
  const timeout = opts?.timeoutMs ?? 30_000;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any = null;
  return {
    async fetchPage(req: BrowseRequest): Promise<BrowseResult> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!browser) browser = await (chromium as any).launch({ headless: true });
      const page = await browser.newPage();
      try {
        await page.goto(req.url, { timeout, waitUntil: "domcontentloaded" });
        const title = await page.title();
        const finalUrl = page.url();
        if (req.extract === "screenshot") {
          const buf = (await page.screenshot({ type: "png" })) as Buffer;
          return {
            url: req.url,
            finalUrl,
            title,
            screenshotBase64: buf.toString("base64"),
          };
        }
        const raw =
          req.extract === "html"
            ? req.selector
              ? await page.locator(req.selector).first().innerHTML()
              : await page.content()
            : req.selector
              ? await page.locator(req.selector).first().innerText()
              : await page.innerText("body");
        const max = req.maxChars ?? 8000;
        const truncated = raw.length > max;
        return {
          url: req.url,
          finalUrl,
          title,
          content: truncated ? raw.slice(0, max) : raw,
          truncated,
        };
      } finally {
        await page.close();
      }
    },
    async close() {
      if (browser) await browser.close();
    },
  };
}
