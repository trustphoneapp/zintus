import { describe, expect, it } from "bun:test";
import { PROVIDER_IDS } from "@zintus/types";
import {
  PROVIDERS,
  MODELS,
  ROUTABLE_PROVIDER_IDS,
  isRoutableProvider,
  isRoutableModel,
} from "./providers";
import { CATALOG_STATS } from "./catalog-stats";

// HONESTY INVARIANT (load-bearing): the public catalog must never imply a
// capability with no real code path. The router can reach EXACTLY the provider
// IDs in the closed `ProviderId` union (`PROVIDER_IDS` from @zintus/types).
// Anything else is "Planned — not yet routable" and must NOT carry an actionable
// BYOK ("add-key") badge nor be presented as "integrated"/usable today.
describe("catalog honesty", () => {
  it("ROUTABLE_PROVIDER_IDS matches the router's real ProviderId union exactly", () => {
    expect([...ROUTABLE_PROVIDER_IDS].sort()).toEqual([...PROVIDER_IDS].sort());
    // 12 original + 10 added 2026-07-02 via the provider manifest (P1).
    expect(ROUTABLE_PROVIDER_IDS.size).toBe(22);
  });

  it("no non-routable provider carries an actionable badge (add-key/integrated)", () => {
    const offenders = PROVIDERS.filter(
      (p) => !isRoutableProvider(p.id) && p.badge !== "coming-soon",
    );
    expect(offenders.map((p) => `${p.id}:${p.badge}`)).toEqual([]);
  });

  it("the only 'add-key' BYOK badge belongs to a routable provider (openrouter)", () => {
    const addKey = PROVIDERS.filter((p) => p.badge === "add-key");
    expect(addKey.every((p) => isRoutableProvider(p.id))).toBe(true);
    expect(addKey.map((p) => p.id)).toEqual(["openrouter"]);
  });

  it("every routable provider is honestly badged integrated or add-key (never coming-soon)", () => {
    const routable = PROVIDERS.filter((p) => isRoutableProvider(p.id));
    expect(routable.every((p) => p.badge === "integrated" || p.badge === "add-key")).toBe(true);
  });

  it("no model whose provider is non-routable is flagged routable", () => {
    const lying = MODELS.filter(
      (m) => !ROUTABLE_PROVIDER_IDS.has(m.provider) && isRoutableModel(m),
    );
    expect(lying).toEqual([]);
  });

  it("catalog stats report the honest split: 22 routable providers, the rest planned", () => {
    expect(CATALOG_STATS.routableProviders).toBe(22);
    expect(CATALOG_STATS.plannedProviders).toBe(PROVIDERS.length - 22);
    expect(CATALOG_STATS.routableProviders + CATALOG_STATS.plannedProviders).toBe(
      CATALOG_STATS.totalProviders,
    );
    expect(CATALOG_STATS.routableModels + CATALOG_STATS.plannedModels).toBe(
      CATALOG_STATS.totalModels,
    );
    // Every routable model's provider must be in the routable set.
    expect(
      MODELS.filter((m) => isRoutableModel(m)).every((m) =>
        ROUTABLE_PROVIDER_IDS.has(m.provider),
      ),
    ).toBe(true);
  });
});
