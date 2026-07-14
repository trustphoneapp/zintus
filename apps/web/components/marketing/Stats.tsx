import { CATALOG_STATS, floorTo } from "@/data/catalog-stats";
import { StatsClient, type Stat } from "./StatsClient";

// Server Component. Provider/model counts are derived from data/providers.ts
// (via catalog-stats) and floored to a round "N+" figure so this headline never
// drifts from — or overclaims relative to — the actual catalog, and never has to
// be hand-edited as the catalog grows. Keep in sync with ProviderGrid.tsx and
// Features.tsx. Resolving the numbers here (server-side) and passing the fully
// computed `STATS` array to the <StatsClient> island keeps the catalog data
// graph out of the client bundle — only the final integers cross the boundary.
const STATS: Stat[] = [
  { prefix: "", target: floorTo(CATALOG_STATS.totalProviders, 10), suffix: "+", unit: " providers", label: "Direct + meta-router catalog", caption: "DIRECT + BYOK CATALOG" },
  { prefix: "", target: floorTo(CATALOG_STATS.totalModels, 10), suffix: "+", unit: " models", label: "Curated and growing weekly", caption: "REFRESHED WEEKLY" },
  { prefix: "< ", target: 5, suffix: "ms", unit: " routing", label: "In-process quota check", caption: "IN-PROCESS QUOTA CHECK" },
  { prefix: "", target: 0, suffix: "%", unit: " markup", label: "On your own API keys", caption: "ON YOUR OWN API KEYS", featured: true },
];

export function Stats() {
  return <StatsClient stats={STATS} />;
}
