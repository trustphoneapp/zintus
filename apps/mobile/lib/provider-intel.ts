import {
  DATA_POLICIES,
  getModelPricing,
  type TrainingBadge,
} from "@zintus/providers";
import type { ProviderId } from "@zintus/types";

import { getApiKey } from "@/lib/keys";
import { validateProviderKey } from "@/lib/validate";

export type BadgeTone = "good" | "warn" | "muted";

export interface PolicyBadge {
  label: string;
  tone: BadgeTone;
  /** True for ZDR / no-training — the privacy-preferred providers. */
  privacyPreferred: boolean;
  note: string;
  policyUrl: string;
}

const BADGE_LABEL: Record<TrainingBadge, { label: string; tone: BadgeTone }> = {
  "no-training": { label: "No training", tone: "good" },
  zdr: { label: "Zero retention", tone: "good" },
  trains: { label: "May train on data", tone: "warn" },
  unknown: { label: "Policy unknown", tone: "muted" },
};

/** Privacy/training badge for a provider, sourced from @zintus/providers. */
export function policyBadge(providerId: ProviderId): PolicyBadge {
  const policy = DATA_POLICIES[providerId];
  const base = BADGE_LABEL[policy.badge];
  return {
    label: policy.zdr ? "Zero retention" : base.label,
    tone: policy.zdr ? "good" : base.tone,
    privacyPreferred: policy.zdr || policy.badge === "no-training",
    note: policy.note,
    policyUrl: policy.policyUrl,
  };
}

/** Whether Private Mode (block training) would exclude this provider. */
export function blockedByPrivateMode(providerId: ProviderId): boolean {
  return DATA_POLICIES[providerId].trainsOnData === true;
}

/** "$0.59 / $0.79 per 1M" estimate for a provider's default model, or null. */
export function priceLabel(providerId: ProviderId, model: string): string | null {
  if (providerId === "ollama" || providerId === "lmstudio") {
    return "Free · local";
  }
  const pricing = getModelPricing(providerId, model);
  if (!pricing) return null;
  return `~$${pricing.inputPer1M} in / $${pricing.outputPer1M} out per 1M`;
}

export type KeyTestResult = "ok" | "bad" | "nokey";

/** Validate the key currently stored for a provider (control-center Test). */
export async function testStoredKey(
  providerId: ProviderId,
): Promise<KeyTestResult> {
  const key = await getApiKey(providerId);
  if (!key?.trim()) return "nokey";
  return (await validateProviderKey(providerId, key)) ? "ok" : "bad";
}
