import type { ProviderId } from "@zintus/types";

/**
 * Best-effort summaries of each provider's free-tier data-handling policy.
 *
 * These are NOT a substitute for the provider's own terms — they are a
 * convenience signal so users can route away from providers that may train on
 * their data. The linked `policyUrl` is the source of truth. Values are
 * conservative: where a provider's free-tier training behaviour is not clearly
 * documented, `trainsOnData` is `"unknown"` rather than asserted either way.
 *
 * Last reviewed: 2026-06. Re-verify against the linked policies before relying
 * on these for a compliance decision.
 */

export type TrainingBadge = "no-training" | "trains" | "zdr" | "unknown";

export interface DataPolicy {
  /** Whether the free tier may use prompts/responses to train models. */
  trainsOnData: boolean | "unknown";
  /** Short human-readable retention summary. */
  dataRetention: string;
  /** Zero data retention (no logging of prompt/response content). */
  zdr: boolean;
  /** Badge shown in the UI. */
  badge: TrainingBadge;
  policyUrl: string;
  note: string;
}

export const DATA_POLICIES: Record<ProviderId, DataPolicy> = {
  cerebras: {
    trainsOnData: false,
    dataRetention: "Not used for training",
    zdr: false,
    badge: "no-training",
    policyUrl: "https://www.cerebras.ai/privacy-policy",
    note: "Inference API; does not train on submitted data.",
  },
  groq: {
    trainsOnData: false,
    dataRetention: "Logs retained for abuse prevention",
    zdr: false,
    badge: "no-training",
    policyUrl: "https://groq.com/privacy-policy",
    note: "Does not train on API data; short-term logs for abuse prevention.",
  },
  gemini: {
    trainsOnData: true,
    dataRetention: "Free tier may be used to improve models",
    zdr: false,
    badge: "trains",
    policyUrl: "https://ai.google.dev/gemini-api/terms",
    note: "Free (unpaid) tier: prompts and responses may be used to improve Google products.",
  },
  openrouter: {
    trainsOnData: "unknown",
    dataRetention: "Depends on the downstream provider",
    zdr: false,
    badge: "unknown",
    policyUrl: "https://openrouter.ai/privacy",
    note: "Proxies to downstream providers; data handling depends on the chosen model/route.",
  },
  cohere: {
    trainsOnData: true,
    dataRetention: "Trial keys may be used for improvement",
    zdr: false,
    badge: "trains",
    policyUrl: "https://cohere.com/privacy",
    note: "Trial/free usage may be used to improve services; production terms differ.",
  },
  mistral: {
    trainsOnData: false,
    dataRetention: "Not used for training by default",
    zdr: false,
    badge: "no-training",
    policyUrl: "https://mistral.ai/terms/",
    note: "La Plateforme does not train on API data by default.",
  },
  deepseek: {
    trainsOnData: "unknown",
    dataRetention: "Unclear / may be retained",
    zdr: false,
    badge: "unknown",
    policyUrl: "https://www.deepseek.com/privacy",
    note: "Free-tier training behaviour not clearly documented; treat as uncertain.",
  },
  fireworks: {
    trainsOnData: false,
    dataRetention: "Not used for training",
    zdr: false,
    badge: "no-training",
    policyUrl: "https://fireworks.ai/privacy-policy",
    note: "Inference platform; does not train on submitted data.",
  },
  xai: {
    trainsOnData: "unknown",
    dataRetention: "Varies; trial credits",
    zdr: false,
    badge: "unknown",
    policyUrl: "https://x.ai/legal/privacy-policy",
    note: "Free-tier training behaviour not clearly documented; treat as uncertain.",
  },
  huggingface: {
    trainsOnData: "unknown",
    dataRetention: "Depends on the routed inference provider",
    zdr: false,
    badge: "unknown",
    policyUrl: "https://huggingface.co/privacy",
    note: "Router forwards to third-party inference providers; handling varies.",
  },
  lmstudio: {
    trainsOnData: false,
    dataRetention: "Local — stays on your machine",
    zdr: true,
    badge: "zdr",
    policyUrl: "local",
    note: "Runs locally; no data leaves your device.",
  },
  ollama: {
    trainsOnData: false,
    dataRetention: "Local — stays on your machine",
    zdr: true,
    badge: "zdr",
    policyUrl: "local",
    note: "Runs locally; no data leaves your device.",
  },
};

/** Providers that definitely train on free-tier data (excludes "unknown"). */
export function trainsOnUserData(providerId: ProviderId): boolean {
  return DATA_POLICIES[providerId]?.trainsOnData === true;
}
