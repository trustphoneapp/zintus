import { createAppRouter, getProviderInfos } from "../lib/router.js";
import { loadConfig } from "../lib/config.js";

/**
 * `zintus status --json` — one snapshot of the same facts the live ink
 * dashboard shows (provider key/cooldown/quota + estimated savings), for
 * automation. Lives in its own module so the JSON path never imports
 * ink/React at all (no TTY assumptions, no renderer). No fabricated quota
 * denominators: `quotaLimit` stays null when the provider reports none.
 */
export async function printStatusJson(): Promise<void> {
  const config = await loadConfig();
  const router = createAppRouter(config);
  const infos = await getProviderInfos(router);
  const savings = router.getSavings();
  console.log(
    JSON.stringify(
      {
        providers: infos.map((p) => ({
          id: p.id,
          name: p.name,
          hasKey: p.hasKey,
          enabled: p.enabled,
          inCooldown: p.inCooldown,
          quotaUsed: p.quotaUsed,
          quotaLimit: p.quotaLimit ?? null,
        })),
        configured: infos.filter((p) => p.hasKey).length,
        savings: {
          estimatedUsdSaved: Number(savings.total.toFixed(4)),
          note: "estimate vs. paid-API list pricing",
        },
      },
      null,
      2,
    ),
  );
}
