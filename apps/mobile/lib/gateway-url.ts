import { NativeModules } from "react-native";
import { createMMKV } from "react-native-mmkv";
import {
  GATEWAY_PORT,
  devHostUrlFromScriptUrl,
  normalizeGatewayUrl,
  resolveGatewayUrl,
} from "./gateway-url-resolve";

const ENV_GATEWAY_URL = process.env.EXPO_PUBLIC_GATEWAY_URL?.trim() || null;

// Shares the same MMKV store as lib/config.ts (MMKV is a singleton per id).
const storage = createMMKV({ id: "zintus.config" });
const GATEWAY_URL_KEY = "gatewayUrl";

/** The Metro bundler URL (dev only); null/`file://` in a production build. */
function metroScriptUrl(): string | null {
  try {
    const source = NativeModules?.SourceCode as
      | { getConstants?: () => { scriptURL?: string }; scriptURL?: string }
      | undefined;
    return source?.getConstants?.().scriptURL ?? source?.scriptURL ?? null;
  } catch {
    return null;
  }
}

// scriptURL doesn't change during a session — derive the dev host once.
let cachedDevUrl: string | null | undefined;
function detectDevHostUrl(): string | null {
  if (cachedDevUrl === undefined) {
    cachedDevUrl = devHostUrlFromScriptUrl(metroScriptUrl());
  }
  return cachedDevUrl;
}

/** The default used when the user hasn't set an explicit URL (for settings UI). */
export function getDefaultGatewayUrl(): string {
  if (ENV_GATEWAY_URL) {
    return normalizeGatewayUrl(ENV_GATEWAY_URL);
  }
  return detectDevHostUrl() ?? `http://localhost:${GATEWAY_PORT}`;
}

/** The user-saved override, if any. */
export function getSavedGatewayUrl(): string | null {
  return storage.getString(GATEWAY_URL_KEY)?.trim() || null;
}

/**
 * Effective gateway URL. Resolution order: a URL the user saved in Settings →
 * the build-time `EXPO_PUBLIC_GATEWAY_URL` → the auto-detected dev host →
 * `localhost` as a last resort.
 */
export function getGatewayUrl(): string {
  return resolveGatewayUrl({
    saved: getSavedGatewayUrl(),
    env: ENV_GATEWAY_URL,
    scriptURL: metroScriptUrl(),
  });
}

/**
 * Persist a user-chosen gateway URL, or clear it (back to auto-detect) when
 * blank. Stored as "" rather than deleted — getSavedGatewayUrl treats empty as
 * no override — so this works regardless of the MMKV version's delete API.
 */
export function setGatewayUrl(url: string): void {
  const trimmed = url.trim();
  storage.set(GATEWAY_URL_KEY, trimmed ? normalizeGatewayUrl(trimmed) : "");
}
