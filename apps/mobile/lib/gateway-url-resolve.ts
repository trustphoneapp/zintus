// Pure gateway-URL resolution, free of react-native / MMKV imports so it can be
// unit-tested under bun. lib/gateway-url.ts wires the real NativeModules + MMKV
// values into these helpers.

export const GATEWAY_PORT = 8788;

export function normalizeGatewayUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Derive the gateway URL from the Metro bundler `scriptURL`. In dev that host is
 * how the device actually reaches the dev machine (a LAN IP, or `10.0.2.2` on
 * the Android emulator). `localhost`/`127.0.0.1` point the device at itself, so
 * they're rejected. Returns null in production (scriptURL is a `file://` path).
 */
export function devHostUrlFromScriptUrl(
  scriptURL: string | null | undefined,
): string | null {
  const host = scriptURL?.match(/^https?:\/\/([^/:]+)/)?.[1];
  if (host && host !== "localhost" && host !== "127.0.0.1") {
    return `http://${host}:${GATEWAY_PORT}`;
  }
  return null;
}

/**
 * Effective gateway URL. Priority: user-saved (Settings) → build-time env →
 * auto-detected dev host → `localhost` as a last resort.
 */
export function resolveGatewayUrl(opts: {
  saved?: string | null;
  env?: string | null;
  scriptURL?: string | null;
}): string {
  const saved = opts.saved?.trim();
  if (saved) {
    return normalizeGatewayUrl(saved);
  }
  const env = opts.env?.trim();
  if (env) {
    return normalizeGatewayUrl(env);
  }
  return devHostUrlFromScriptUrl(opts.scriptURL) ?? `http://localhost:${GATEWAY_PORT}`;
}
