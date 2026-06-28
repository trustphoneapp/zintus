import chalk from "chalk";
import {
  setKey,
  setKeys,
  deleteKey,
  listKeys,
  getKey,
  getKeys,
} from "@zintus/keychain";
import { createProvider } from "@zintus/providers";
import { isProviderId, PROVIDER_IDS } from "@zintus/types";

const VALIDATE_URL =
  process.env.ZINTUS_VALIDATE_URL ??
  "https://relay.zintus.ai/validate";

import type { ProviderId } from "@zintus/types";

async function validateKeyRemote(
  provider: ProviderId,
  key: string,
): Promise<{ valid: boolean; error?: string }> {
  if (process.env.ZINTUS_SKIP_VALIDATE === "1") {
    const local = createProvider(provider);
    const valid = await local.validateKey(key);
    return valid ? { valid: true } : { valid: false, error: "Invalid key format or provider rejected key" };
  }

  try {
    const res = await fetch(VALIDATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId: provider, key }),
      signal: AbortSignal.timeout(10_000),
    });
    return (await res.json()) as { valid: boolean; error?: string };
  } catch {
    const local = createProvider(provider);
    const valid = await local.validateKey(key);
    return valid
      ? { valid: true }
      : { valid: false, error: "Validation service unreachable and local check failed" };
  }
}

/**
 * Validate and store a key, returning a result instead of exiting. Shared by the
 * `keys set` command (which exits on failure) and the setup wizard (which retries
 * inline) so a bad key never tears down an interactive flow.
 */
export async function validateAndStoreKey(
  provider: ProviderId,
  key: string,
  options?: { fallback?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  if (provider !== "ollama" && provider !== "lmstudio") {
    const result = await validateKeyRemote(provider, key);
    if (!result.valid) {
      return { ok: false, error: result.error ?? "Key validation failed" };
    }
  }
  if (options?.fallback) {
    // BYOK priority + fallback: APPEND to the ordered key list (primary first).
    // The router tries the next key on an auth (401/403) failure before
    // abandoning the provider. `setKey` (no --fallback) still replaces with a
    // sole primary, so the default behavior is unchanged.
    const existing = await getKeys(provider);
    await setKeys(provider, [...existing, key]);
  } else {
    await setKey(provider, key);
  }
  return { ok: true };
}

export async function runKeysSet(
  provider: string,
  key: string,
  options?: { fallback?: boolean },
): Promise<void> {
  if (!isProviderId(provider)) {
    console.error(
      chalk.red(`Unknown provider: ${provider}`),
      chalk.dim(`\nValid: ${PROVIDER_IDS.join(", ")}`),
    );
    process.exit(1);
  }

  const result = await validateAndStoreKey(provider, key, options);
  if (!result.ok) {
    console.error(chalk.red(result.error ?? "Key validation failed"));
    process.exit(1);
  }

  if (options?.fallback) {
    const total = (await getKeys(provider)).length;
    console.log(
      chalk.green(`✓ Added fallback key for ${provider}`),
      chalk.dim(`(${total} key${total === 1 ? "" : "s"} in priority order)`),
    );
  } else {
    console.log(chalk.green(`✓ Stored key for ${provider}`));
  }
}

export async function runKeysList(options?: { json?: boolean }): Promise<void> {
  const keys = await listKeys();

  if (options?.json) {
    console.log(JSON.stringify(keys));
    return;
  }

  if (keys.length === 0) {
    console.log(chalk.dim("No API keys stored."));
    console.log(chalk.dim("Use: zintus keys set <provider> <key>"));
    return;
  }

  console.log(chalk.bold("Stored API keys:\n"));
  for (const { provider, masked } of keys) {
    // Show the fallback count so the priority list (primary + fallbacks) is
    // visible. A provider with a single key prints exactly as before.
    const count = isProviderId(provider)
      ? (await getKeys(provider)).length
      : 1;
    const suffix =
      count > 1 ? chalk.dim(` (+${count - 1} fallback)`) : "";
    console.log(`  ${chalk.cyan(provider.padEnd(12))} ${masked}${suffix}`);
  }
}

export async function runKeysTest(provider: string): Promise<void> {
  if (!isProviderId(provider)) {
    console.error(
      chalk.red(`Unknown provider: ${provider}`),
      chalk.dim(`\nValid: ${PROVIDER_IDS.join(", ")}`),
    );
    process.exit(1);
  }

  if (provider === "ollama" || provider === "lmstudio") {
    console.log(chalk.dim(`${provider} is a local runtime — no key to test.`));
    return;
  }

  const key = await getKey(provider);
  if (!key) {
    console.error(
      chalk.red(`No key stored for ${provider}.`),
      chalk.dim(`\nAdd one: zintus keys set ${provider} <key>`),
    );
    process.exit(1);
  }

  const result = await validateKeyRemote(provider, key);
  if (result.valid) {
    console.log(chalk.green(`✓ ${provider} key is valid`));
  } else {
    console.error(
      chalk.red(`✗ ${provider} key rejected: ${result.error ?? "invalid"}`),
    );
    process.exit(1);
  }
}

export async function runKeysRemove(provider: string): Promise<void> {
  if (!isProviderId(provider)) {
    console.error(
      chalk.red(`Unknown provider: ${provider}`),
      chalk.dim(`\nValid: ${PROVIDER_IDS.join(", ")}`),
    );
    process.exit(1);
  }

  const existing = await getKey(provider);
  await deleteKey(provider);

  if (existing) {
    console.log(chalk.green(`✓ Removed key for ${provider}`));
  } else {
    console.log(chalk.yellow(`No key found for ${provider}`));
  }
}
