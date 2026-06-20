import { createProvider } from "@zintus/providers";
import type { ProviderId } from "@zintus/types";
import { VALIDATE_URL } from "./limits";

export async function validateProviderKey(
  providerId: ProviderId,
  key: string,
): Promise<boolean> {
  try {
    const response = await fetch(VALIDATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId, key }),
    });

    if (!response.ok) {
      return false;
    }

    const body = (await response.json()) as { valid?: boolean };
    return Boolean(body.valid);
  } catch {
    return createProvider(providerId).validateKey(key);
  }
}
