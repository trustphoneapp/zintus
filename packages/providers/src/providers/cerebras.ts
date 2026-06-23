import { createOpenAiCompatProvider } from "../openai-compat.js";

export const cerebrasProvider = createOpenAiCompatProvider({
  id: "cerebras",
  name: "Cerebras",
  color: "#10B981",
  priority: 1,
  keyRegex: /^csk-[a-zA-Z0-9]{40,}$/,
  defaultModel: "llama-3.3-70b",
  baseUrl: "https://api.cerebras.ai/v1",
});
