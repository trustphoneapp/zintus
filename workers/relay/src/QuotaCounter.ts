/**
 * QuotaCounter — a strongly-consistent, atomic token-usage counter.
 *
 * Why a Durable Object: the previous quota counter was a KV read-modify-write
 * (`get` → add → `put`), which is NOT atomic. Concurrent `recordUsage` calls all
 * read the same value and the last write wins, so increments are silently lost
 * and a user can drift *under* their recorded usage and exceed quota. Cloudflare's
 * own guidance is explicit: KV is eventually consistent with last-write-wins, and
 * "if you're incrementing counters … or implementing accurate rate limits, use
 * Durable Objects" — each DO has transactional, strongly-consistent storage and
 * the runtime serialises requests to a single object instance, so there is no
 * lost-update race.
 *   - https://developers.cloudflare.com/durable-objects/examples/build-a-counter/
 *   - https://developers.cloudflare.com/kv/concepts/how-kv-works/  (eventual consistency)
 *
 * One DO instance per `user:period` (see idFromName in middleware/quota.ts), so
 * load is naturally sharded per user-month and stays well under a single object's
 * throughput ceiling.
 *
 * The `get`/`add` read-then-write below runs with no intervening I/O, so it is
 * atomic per the DO storage model; combined with per-object request
 * serialisation, concurrent `add`s accumulate exactly.
 *
 * Storage hygiene: a counter exists per `user:period`, so without cleanup one
 * tiny instance would persist forever once a month rolls over. The old KV
 * counter had a 35-day TTL; here every write (re)arms a DO `alarm()` ~40 days
 * out, and the alarm wipes the instance's storage. The alarm therefore only
 * fires after the counter has been idle past its billing month, emulating the
 * TTL without a cron/prune job.
 */
const PRUNE_AFTER_MS = 40 * 24 * 60 * 60 * 1000;

export class QuotaCounter {
  private storage: DurableObjectStorage;

  constructor(state: DurableObjectState) {
    this.storage = state.storage;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/add" && request.method === "POST") {
      const n = parseInt(await request.text(), 10);
      const delta = Number.isFinite(n) && n > 0 ? n : 0;
      const current = (await this.storage.get<number>("t")) ?? 0;
      const total = current + delta;
      await this.storage.put("t", total);
      // (Re)arm the self-prune alarm on each write so it fires only once the
      // counter has been idle ~40 days (well past the billing month).
      await this.storage.setAlarm(Date.now() + PRUNE_AFTER_MS);
      return Response.json({ total });
    }

    // Default: read current total.
    const total = (await this.storage.get<number>("t")) ?? 0;
    return Response.json({ total });
  }

  /** Fires ~40 days after the last write: drop the stale counter's storage. */
  async alarm(): Promise<void> {
    await this.storage.deleteAll();
  }
}
