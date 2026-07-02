/**
 * Single source of truth for Zintus's data-destination story on mobile.
 *
 * The hard product constraint is that the app must ALWAYS make clear what stays
 * on the device, what passes through the user's gateway, what reaches the chosen
 * AI provider, and what (only auth/session) touches the relay. Encoding it here
 * keeps every surface — onboarding, the composer, attachment notices, Private
 * Mode, Deep Research — consistent and auditable, instead of re-describing the
 * flow (and risking a wrong claim) in each screen.
 *
 * Invariants this module asserts (and the rest of the app must honor):
 *  - Provider API keys live ON DEVICE (SecureStore); the relay never holds them.
 *  - User prompts / images / files go to the selected PROVIDER (or a LOCAL
 *    runtime), routed THROUGH the gateway — never to the relay.
 *  - The relay is auth / session / control plane ONLY.
 */

export type Destination = "device" | "gateway" | "provider" | "relay";

export interface DestinationInfo {
  label: string;
  /** One-line plain-language description of this destination's role. */
  blurb: string;
}

export const DESTINATIONS: Record<Destination, DestinationInfo> = {
  device: {
    label: "On device",
    blurb:
      "Stays on your phone. Provider keys, chat history, and settings are stored locally (keys in the OS secure store).",
  },
  gateway: {
    label: "Your gateway",
    blurb:
      "The router you run (`zintus serve`) on your computer/LAN. It compresses and routes your request — it is the execution plane.",
  },
  provider: {
    label: "AI provider",
    blurb:
      "The model vendor you chose (Groq, Gemini, Cerebras, Mistral, OpenRouter, …), reached with YOUR key. Your prompt/files are processed here.",
  },
  relay: {
    label: "Zintus relay",
    blurb:
      "Auth, session, and control plane ONLY. It never receives your prompts, files, images, or provider keys.",
  },
};

/** How privacy-sensitive a turn is, which changes where data may travel. */
export type PrivacyPosture = "standard" | "local-only";

export interface DataFlowItem {
  data: string;
  destination: Destination;
  detail: string;
}

/**
 * The ordered data-flow for a chat/attachment turn, given the privacy posture.
 * `local-only` keeps everything on a local runtime via the gateway — nothing
 * leaves the user's own machines.
 */
export function describeFlow(posture: PrivacyPosture): DataFlowItem[] {
  const items: DataFlowItem[] = [
    {
      data: "Provider API keys",
      destination: "device",
      detail: "Encrypted in the OS secure store. Never sent to the relay.",
    },
    {
      data: "Your prompt, images & files",
      destination: "gateway",
      detail: "Sent to your gateway to be compressed and routed.",
    },
  ];

  if (posture === "local-only") {
    items.push({
      data: "Your prompt, images & files",
      destination: "gateway",
      detail:
        "Run on a LOCAL model (Ollama / LM Studio) via the gateway — nothing leaves your own machines.",
    });
  } else {
    items.push({
      data: "Your prompt, images & files",
      destination: "provider",
      detail:
        "Forwarded by the gateway to the AI provider you selected, using your key.",
    });
  }

  items.push({
    data: "Sign-in session (only if you log in)",
    destination: "relay",
    detail: "Auth token only. The relay never sees prompts, files, or keys.",
  });

  return items;
}

/**
 * The notice shown BEFORE the first attachment (image/file) is sent, adapted to
 * the active privacy posture. Wording is intentionally concrete about where the
 * bytes go so the user can make an informed choice.
 */
export function attachmentPrivacyNotice(posture: PrivacyPosture): string[] {
  if (posture === "local-only") {
    return [
      "Private (local-only) mode is on: this file/image runs on a local model via your gateway and does not leave your machines.",
      "Zintus relay does not process this prompt.",
    ];
  }
  return [
    "This file/image will be sent to the selected AI provider through your gateway.",
    "Use Private Mode / a local runtime if you do not want it to leave your device.",
    "Zintus relay does not process this prompt.",
  ];
}
