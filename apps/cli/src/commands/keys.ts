import chalk from "chalk";
import { setKey, deleteKey, listKeys, getKey } from "@multipleai/keychain";
import { createProvider } from "@multipleai/providers";
import { isProviderId, PROVIDER_IDS } from "@multipleai/types";

const VALIDATE_URL =
  process.env.MULTIPLEAI_VALIDATE_URL ??
  "http://localhost:8787/validate";

import type { ProviderId } from "@multipleai/types";

async function validateKeyRemote(
  provider: ProviderId,
  key: string,
): Promise<{ valid: boolean; error?: string }> {
  if (process.env.MULTIPLEAI_SKIP_VALIDATE === "1") {
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

export async function runKeysSet(
  provider: string,
  key: string,
): Promise<void> {
  if (!isProviderId(provider)) {
    console.error(
      chalk.red(`Unknown provider: ${provider}`),
      chalk.dim(`\nValid: ${PROVIDER_IDS.join(", ")}`),
    );
    process.exit(1);
  }

  if (provider !== "ollama" && provider !== "lmstudio") {
    const result = await validateKeyRemote(provider, key);
    if (!result.valid) {
      console.error(chalk.red(result.error ?? "Key validation failed"));
      process.exit(1);
    }
  }

  await setKey(provider, key);
  console.log(chalk.green(`✓ Stored key for ${provider}`));
}

export async function runKeysList(): Promise<void> {
  const keys = await listKeys();

  if (keys.length === 0) {
    console.log(chalk.dim("No API keys stored."));
    console.log(chalk.dim("Use: multipleai keys set <provider> <key>"));
    return;
  }

  console.log(chalk.bold("Stored API keys:\n"));
  for (const { provider, masked } of keys) {
    console.log(`  ${chalk.cyan(provider.padEnd(12))} ${masked}`);
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
