import { createOpenAiCompatProvider } from "../openai-compat.js";

export const GROQ_MODEL_70B = "llama-3.3-70b-versatile";
export const GROQ_MODEL_8B = "llama-3.1-8b-instant";

export const groqProvider = createOpenAiCompatProvider({
  id: "groq",
  name: "Groq",
  color: "#F59E0B",
  priority: 2,
  keyRegex: /^gsk_[a-zA-Z0-9]{50,}/,
  defaultModel: GROQ_MODEL_70B,
  baseUrl: "https://api.groq.com/openai/v1",
  includeRateLimit: true,
});
