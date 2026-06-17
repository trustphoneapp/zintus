import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  type AppConfig,
  type RoutingStrategy,
} from "@multipleai/types";

export const CONFIG_PATH = join(homedir(), ".multipleai", "config.json");

export async function loadConfig(): Promise<AppConfig> {
  try {
    const raw = await readFile(CONFIG_PATH, "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) } as AppConfig;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await mkdir(join(homedir(), ".multipleai"), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function isRoutingStrategy(value: string): value is RoutingStrategy {
  return ["fastest", "capability", "economy"].includes(value);
}
