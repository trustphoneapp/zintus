# Zintus Community Leaderboard — design (P1, not yet live)

The inverted data moat (plan §4): OpenRouter's rankings come from observing
traffic they proxy; Zintus can publish the only rankings sourced from
**free-tier, BYOK, locally-routed** workloads — data OpenRouter structurally
cannot collect — without ever seeing a prompt.

## Principles (non-negotiable)

1. **Opt-in, off by default.** `telemetry.leaderboard: true` in policy.json.
2. **Aggregates only.** The shared document is exactly what
   `scripts/leaderboard-export.ts` emits (`zintus.leaderboard.v1`): per
   (provider, model) request counts, success rate, latency p50/p95, token
   totals over a coarse window. No prompts, keys, thread ids, IPs, or
   fine-grained timestamps. The user can run the export and read every byte
   before enabling sharing.
3. **k-anonymity at ingest.** The public board only displays a (provider,
   model) cell once ≥ 20 distinct submitters contributed to it.
4. **No account required to contribute; contribution is not tied to relay
   identity** — submissions are keyed by a random self-generated submitter id
   (rotatable), not the user's login.

## Architecture (when built)

```
gateway (opt-in)  →  POST /leaderboard/v1/submit  (relay worker, new route)
                      · validates zintus.leaderboard.v1 schema (zod, shared)
                      · rate-limits per submitter id
                      · D1: submissions(submitter_id, window, provider, model, aggregates)
nightly DO alarm  →  materialize public aggregates (k≥20) into a static JSON
models.zintus.dev →  static page rendering that JSON (provider/model rankings:
                      p95 latency, success rate, free-tier reliability)
```

## Status

- ✅ Export exists: `bun run scripts/leaderboard-export.ts` (local-only).
- ❌ Relay ingest route, k-anonymity materializer, public page: not built.
- Decision deliberately deferred until the relay is deployed (P0 [HUMAN] item)
  — ingest rides the same worker.

## [HUMAN] before launch

- Approve this consent/anonymity design (it is a public-trust surface).
- Register/point `models.zintus.dev` (or choose the URL).
- Deploy the relay with the ingest route once built.
