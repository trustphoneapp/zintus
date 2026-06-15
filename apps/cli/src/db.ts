import { homedir } from "node:os";
import { join } from "node:path";

export function getDbPath(): string {
  return join(homedir(), ".multipleai", "quota.db");
}
