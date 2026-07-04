/**
 * v1 update check: compare the running version against a static release
 * manifest (https://releases.zintus.ai/desktop/latest.json, [HUMAN] hosts it
 * alongside the signed builds). Full silent auto-update (tauri-plugin-updater
 * + signing keys) is a [HUMAN]-gated follow-up — until then this is an HONEST
 * "a newer version exists → download it" check, never a fake updater.
 */

export const APP_VERSION = "0.2.0"; // keep in sync with src-tauri/tauri.conf.json

const MANIFEST_URL = "https://releases.zintus.ai/desktop/latest.json";

export interface UpdateInfo {
  version: string;
  url: string;
  notes?: string;
}

/** [a > b] for dotted versions ("0.3.1" > "0.2.0"). */
export function versionNewer(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da > db;
  }
  return false;
}

export type UpdateCheck =
  | { status: "current" }
  | { status: "update"; info: UpdateInfo }
  | { status: "unreachable" };

export async function checkForUpdate(): Promise<UpdateCheck> {
  const res = await fetch(MANIFEST_URL, { cache: "no-store" }).catch(() => null);
  if (!res?.ok) return { status: "unreachable" };
  const data = (await res.json().catch(() => null)) as UpdateInfo | null;
  if (!data?.version || !data.url) return { status: "unreachable" };
  return versionNewer(data.version, APP_VERSION)
    ? { status: "update", info: data }
    : { status: "current" };
}
