import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
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
 *
 * SSRF: `executeBrowseCall` blocks private/loopback/link-local/metadata hosts
 * by default (`blockedHostReason`); `allowPrivate` opts into internal targets.
 * DNS rebinding is closed with resolve-then-pin: a DNS-named target is resolved
 * up front, EVERY returned address is vetted (fail-closed on resolution
 * failure), and the vetted address is pinned into the Playwright driver via
 * Chromium's `--host-resolver-rules` so the browser cannot re-resolve the name
 * to something else mid-fetch. Redirects and subresources are covered by a
 * per-request route guard (`makePublicHostGuard`) that name-checks AND
 * resolve-checks every requested host. Residual (accepted): the route guard's
 * own lookup and Chromium's connection are two DNS queries — a resolver
 * alternating answers faster than the OS cache could in principle win that
 * race for a *redirect* target; the primary target is fully pinned.
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
  /** Anti-rebinding pin: the vetted address this hostname MUST connect to.
   *  Set by `executeBrowseCall` after resolve-and-vet; drivers that can pin
   *  (Playwright via --host-resolver-rules) must honor it. */
  pin?: { hostname: string; address: string };
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
 * SSRF guard. The browser runs ON THE USER'S GATEWAY HOST, so an unchecked URL
 * lets the model read the host's own loopback services, LAN devices (router
 * admin panels), and cloud metadata endpoints (169.254.169.254 / fd00:ec2::254).
 * We block those by DEFAULT and require an explicit opt-in to reach them.
 *
 * Returns a human-readable reason string when the host is blocked, or `null`
 * when it is allowed. Blocks by literal-IP class AND by obvious hostname
 * (localhost, *.local, *.internal, metadata.google.internal). DNS-rebinding
 * (a public name that resolves to a private IP) is NOT fully closed here — that
 * needs resolve-then-pin at fetch time in the driver; documented as a residual.
 */
export function blockedHostReason(hostname: string): string | null {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host) return "empty host";

  // Obvious internal hostnames (covers the common non-IP cases).
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal"
  ) {
    return `internal hostname "${host}"`;
  }

  const stripped = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
  const kind = isIP(stripped);
  if (kind === 4) {
    const parts = stripped.split(".").map((p) => Number(p));
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
      return `malformed IPv4 "${stripped}"`;
    }
    const [a, b] = parts as [number, number, number, number];
    if (
      a === 0 || // "this" network
      a === 127 || // loopback
      a === 10 || // private
      (a === 172 && b >= 16 && b <= 31) || // private
      (a === 192 && b === 168) || // private
      a === 169 && b === 254 || // link-local incl. cloud metadata 169.254.169.254
      a >= 224 // multicast / reserved
    ) {
      return `private/loopback/link-local IPv4 "${stripped}"`;
    }
    return null;
  }
  if (kind === 6) {
    const v6 = stripped.toLowerCase();
    if (
      v6 === "::1" || // loopback
      v6 === "::" || // unspecified
      v6.startsWith("fe80:") || // link-local
      v6.startsWith("fc") || // unique-local fc00::/7
      v6.startsWith("fd") ||
      v6.startsWith("::ffff:") || // IPv4-mapped — could embed a private v4
      v6.startsWith("fd00:ec2:") // AWS IMDSv6 metadata
    ) {
      return `private/loopback/link-local IPv6 "${stripped}"`;
    }
    return null;
  }
  // A public DNS name — the literal check passes; callers must still
  // resolve-and-vet it (see resolveAndVetHost) before connecting.
  return null;
}

/** Injectable DNS lookup so the rebinding guard is unit-testable without
 *  touching the network (and without bun `mock.module`, which leaks). */
export type HostLookup = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

const defaultLookup: HostLookup = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

/**
 * Anti-rebinding resolution: resolve a DNS name and vet EVERY returned address
 * with `blockedHostReason`. Fail-closed — a name that does not resolve is
 * refused (we cannot vet what we cannot see). On success returns one vetted
 * address (IPv4 preferred — Chromium host-resolver-rules take it verbatim) for
 * the driver to pin the connection to.
 */
export async function resolveAndVetHost(
  hostname: string,
  lookupFn: HostLookup = defaultLookup,
): Promise<{ reason: string | null; address?: string }> {
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookupFn(hostname);
  } catch {
    return { reason: `"${hostname}" did not resolve` };
  }
  if (!addrs || addrs.length === 0) {
    return { reason: `"${hostname}" did not resolve` };
  }
  for (const a of addrs) {
    const blocked = blockedHostReason(a.address);
    if (blocked) {
      return {
        reason: `"${hostname}" resolves to ${blocked} — blocked by the DNS-rebinding guard`,
      };
    }
  }
  const v4 = addrs.find((a) => a.family === 4);
  return { reason: null, address: (v4 ?? addrs[0]!).address };
}

/**
 * Per-request host guard for the driver's route interception: covers redirects
 * and subresources, which `executeBrowseCall` cannot see. Name-checks first
 * (cheap), then resolve-checks DNS names. Results are memoized per guard
 * instance so a page with many same-host requests does one lookup.
 */
export function makePublicHostGuard(
  lookupFn: HostLookup = defaultLookup,
): (hostname: string) => Promise<string | null> {
  const cache = new Map<string, string | null>();
  return async (hostname: string) => {
    const host = hostname.trim().toLowerCase();
    const hit = cache.get(host);
    if (hit !== undefined) return hit;
    let reason = blockedHostReason(host);
    if (!reason && isIP(host.replace(/^\[|\]$/g, "")) === 0) {
      reason = (await resolveAndVetHost(host, lookupFn)).reason;
    }
    cache.set(host, reason);
    return reason;
  };
}

/**
 * Execute one `browse` tool call against the wired driver. Returns an honest
 * `isError` result (never throws) when the driver is absent, the URL is not
 * http(s), or the driver fails — so the model can recover.
 */
export async function executeBrowseCall(
  call: { id: string; arguments: Record<string, unknown> },
  driver: BrowserDriver | undefined,
  opts?: {
    /** Explicitly permit private/loopback/link-local hosts (default false).
     *  Only set when the host operator has opted into internal browsing. */
    allowPrivate?: boolean;
    /** DNS lookup override for tests; production uses node:dns. */
    lookup?: HostLookup;
  },
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
  // SSRF guard: reject internal targets unless explicitly allowed. The browser
  // runs on the gateway host, so an unchecked URL could read its loopback
  // services, LAN admin panels, or cloud metadata.
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return {
      toolCallId: call.id,
      content: err("url is not parseable."),
      isError: true,
    };
  }
  let pin: BrowseRequest["pin"];
  if (!opts?.allowPrivate) {
    const blocked = blockedHostReason(hostname);
    if (blocked) {
      return {
        toolCallId: call.id,
        content: err(
          `refusing to browse ${blocked}: internal/private network targets are blocked to prevent SSRF. ` +
            "The host operator can enable internal browsing explicitly.",
        ),
        isError: true,
      };
    }
    // Resolve-then-pin: vet what the name ACTUALLY points at, and pin the
    // driver to that address so it cannot be re-resolved mid-fetch.
    const bare = hostname.replace(/^\[|\]$/g, "");
    if (isIP(bare) === 0) {
      const vetted = await resolveAndVetHost(hostname, opts?.lookup);
      if (vetted.reason) {
        return {
          toolCallId: call.id,
          content: err(
            `refusing to browse: ${vetted.reason}. ` +
              "The host operator can enable internal browsing explicitly.",
          ),
          isError: true,
        };
      }
      pin = { hostname: hostname.toLowerCase(), address: vetted.address! };
    }
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
      pin,
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
  /** Per-request host guard (redirects + subresources): return a reason string
   *  to abort the request, null to allow. Wire `makePublicHostGuard()` here
   *  unless the task opted into private browsing. */
  hostGuard?: (hostname: string) => Promise<string | null>;
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
  const hostGuard = opts?.hostGuard;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any = null;
  // The --host-resolver-rules the running browser was launched with. Chromium
  // only takes resolver rules at launch, so a pin change relaunches (rare —
  // one relaunch per distinct pinned host in a task; correctness over reuse).
  let launchedRule: string | null = null;
  return {
    async fetchPage(req: BrowseRequest): Promise<BrowseResult> {
      const rule = req.pin
        ? `MAP ${req.pin.hostname} ${req.pin.address}`
        : null;
      if (browser && rule !== launchedRule) {
        await browser.close();
        browser = null;
      }
      if (!browser) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        browser = await (chromium as any).launch({
          headless: true,
          ...(rule ? { args: [`--host-resolver-rules=${rule}`] } : {}),
        });
        launchedRule = rule;
      }
      const page = await browser.newPage();
      try {
        if (hostGuard) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await page.route("**/*", async (route: any) => {
            let host: string;
            try {
              host = new URL(route.request().url()).hostname;
            } catch {
              return route.abort();
            }
            const reason = await hostGuard(host);
            if (reason) return route.abort();
            return route.continue();
          });
        }
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
