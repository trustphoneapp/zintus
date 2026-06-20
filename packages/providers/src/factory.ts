import type { Provider, ProviderId } from "@zintus/types";
import { cerebrasProvider } from "./providers/cerebras.js";
import { groqProvider } from "./providers/groq.js";
import { geminiProvider } from "./providers/gemini.js";
import {
  cohereProvider,
  deepseekProvider,
  fireworksProvider,
  huggingFaceProvider,
  lmStudioProvider,
  mistralProvider,
  openrouterProvider,
  xaiProvider,
} from "./providers/skeletons.js";
import { ollamaProvider } from "./providers/ollama.js";

const providers: Record<ProviderId, Provider> = {
  cerebras: cerebrasProvider,
  groq: groqProvider,
  gemini: geminiProvider,
  openrouter: openrouterProvider,
  cohere: cohereProvider,
  mistral: mistralProvider,
  deepseek: deepseekProvider,
  fireworks: fireworksProvider,
  xai: xaiProvider,
  huggingface: huggingFaceProvider,
  lmstudio: lmStudioProvider,
  ollama: ollamaProvider,
};

export function createProvider(id: ProviderId): Provider {
  const provider = providers[id];
  if (!provider) {
    throw new Error(`Unknown provider: ${id}`);
  }
  return provider;
}

export function listProviders(): Provider[] {
  return Object.values(providers).sort((a, b) => a.priority - b.priority);
}

export {
  cerebrasProvider,
  groqProvider,
  geminiProvider,
  openrouterProvider,
  cohereProvider,
  mistralProvider,
  deepseekProvider,
  fireworksProvider,
  xaiProvider,
  huggingFaceProvider,
  lmStudioProvider,
  ollamaProvider,
};
