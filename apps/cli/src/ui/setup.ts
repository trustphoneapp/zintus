import * as p from "@clack/prompts";
import chalk from "chalk";
import { runKeysSet } from "../commands/keys.js";
import { listKeys } from "@multipleai/keychain";
import { PROVIDER_IDS, type ProviderId } from "@multipleai/types";
import { PROVIDER_META } from "../lib/router.js";

const CLOUD_PROVIDERS = PROVIDER_IDS.filter(
  (id): id is Exclude<ProviderId, "ollama" | "lmstudio"> =>
    id !== "ollama" && id !== "lmstudio",
);

export async function runSetup(): Promise<void> {
  p.intro(chalk.bgCyan.black(" multipleai setup "));

  const existing = await listKeys();
  if (existing.length > 0) {
    p.log.info(
      `You already have ${existing.length} key(s) stored. Add more or press Ctrl+C to exit.`,
    );
  } else {
    p.log.message(
      chalk.dim(
        "Get free keys: Groq (console.groq.com), Cerebras (cloud.cerebras.ai), Gemini (aistudio.google.com)",
      ),
    );
  }

  const selected = await p.multiselect({
    message: "Which providers do you want to configure?",
    options: CLOUD_PROVIDERS.map((id) => ({
      value: id,
      label: PROVIDER_META[id].name,
    })),
    required: false,
  });

  if (p.isCancel(selected)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const providers = (selected as ProviderId[]) ?? [];
  if (providers.length === 0) {
    p.outro(chalk.yellow("No providers selected."));
    return;
  }

  for (const provider of providers) {
    const key = await p.password({
      message: `${PROVIDER_META[provider].name} API key`,
      validate: (value) => (value.trim() ? undefined : "Key is required"),
    });

    if (p.isCancel(key)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    await runKeysSet(provider, String(key).trim());
  }

  p.outro(chalk.green("Setup complete. Run `multipleai status` to verify providers."));
}
