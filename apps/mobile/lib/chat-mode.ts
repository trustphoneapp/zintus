import type { RoutingStrategy } from "@zintus/types";

import type { PrivacyPosture } from "@/lib/data-flow";

/**
 * The composer's one-tap routing modes. This is the mapping layer the spec's
 * "Fastest / Cheapest / Private" chips need: only Fastest/Cheapest are real
 * routing strategies — "Private" is `block_training`, not a strategy, and
 * "Research" is a different endpoint (its own screen). Centralizing the mapping
 * keeps the composer honest about what each chip actually sends to the gateway.
 *
 * Modes only bite in Auto provider routing; when the user pins a specific
 * provider, the gateway ignores `strategy`.
 */
export type ChatMode = "auto" | "fastest" | "cheapest" | "private";

export interface ChatModeDef {
  mode: ChatMode;
  label: string;
  hint: string;
}

export const CHAT_MODES: ChatModeDef[] = [
  {
    mode: "auto",
    label: "Auto",
    hint: "Route by your default strategy across available free providers.",
  },
  {
    mode: "fastest",
    label: "Fastest",
    hint: "Prefer the provider with the lowest recent latency.",
  },
  {
    mode: "cheapest",
    label: "Cheapest",
    hint: "Spread across providers with the most remaining free-tier quota.",
  },
  {
    mode: "private",
    label: "Private",
    hint: "Refuse providers that train on your data (may reduce availability).",
  },
];

export interface DerivedRouting {
  strategy?: RoutingStrategy;
  blockTraining?: boolean;
  posture: PrivacyPosture;
}

/**
 * Resolve a composer mode into the concrete params `streamChat` sends. The
 * caller's configured default strategy is used for `auto`/`private` so those
 * modes don't silently override the user's Settings choice.
 */
export function deriveRouting(
  mode: ChatMode,
  defaultStrategy: RoutingStrategy,
): DerivedRouting {
  switch (mode) {
    case "fastest":
      return { strategy: "fastest", posture: "standard" };
    case "cheapest":
      return { strategy: "economy", posture: "standard" };
    case "private":
      return {
        strategy: defaultStrategy,
        blockTraining: true,
        posture: "standard",
      };
    case "auto":
    default:
      return { strategy: defaultStrategy, posture: "standard" };
  }
}

export function nextMode(current: ChatMode): ChatMode {
  const idx = CHAT_MODES.findIndex((m) => m.mode === current);
  return CHAT_MODES[(idx + 1) % CHAT_MODES.length].mode;
}
