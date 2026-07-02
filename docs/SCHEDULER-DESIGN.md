# Relay Scheduler — design (P3, partially built)

Manus runs tasks while you're away in its cloud. Zintus's counter: the relay
(which you host) wakes YOUR gateway to run a saved agent task on YOUR machine,
then pushes the result to your phone — no cloud sandbox rental, no custody.

## What already exists

- **Outbound-only relay** (`workers/relay`): the home gateway holds a
  hibernating WebSocket to a Durable Object; the relay can push a message to
  the gateway at any time (status push is already implemented).
- **Gateway agent runtime** (`/v1/agents`, P2): start a task, stream events,
  approve/stop. This is exactly the thing a schedule needs to invoke.
- **Cloudflare cron**: Workers support `scheduled()` handlers + `crons` in
  `wrangler.toml` (native, no extra infra).

## Design

```
wrangler.toml crons  →  relay Worker scheduled() handler (nightly / cron expr)
                         · read saved_schedules from D1 (user_id, cron, task spec)
                         · for each due schedule whose gateway session is CONNECTED:
                             push { type:"run_agent", task, root, allowRun, autoApprove }
                             down the existing GatewaySession WebSocket
home gateway (cloud.ts)  ·  on "run_agent": POST its own /v1/agents (in-process)
                         ·  stream events back up as { type:"agent_event" }
relay                    ·  persists a run record (D1) + push-notifies mobile
mobile                   ·  "your scheduled task finished" → opens the event log
```

### Saved-schedule shape (D1 `saved_schedules`)

```
id, user_id, cron (string), task, root, allow_run, auto_approve,
enabled, last_run_at, next_run_at, created_at
```

### Safety

- A scheduled run that needs a write/run approval and is NOT `auto_approve`
  **pauses and push-notifies** — it never auto-approves silently. `auto_approve`
  on a schedule is opt-in per schedule, shown prominently.
- Schedules only fire when the gateway session is live; a missed window is
  recorded, never retried blindly.
- Same no-custody bar: the task text + code never leave the home machine; the
  relay carries only the trigger and event metadata (the P2 events are already
  key/secret-free).

## Status

- ✅ Transport (relay WS push) + the runtime to invoke (`/v1/agents`) exist.
- ❌ `saved_schedules` D1 table, the `scheduled()` cron handler, the
  gateway `run_agent` message handler in `cloud.ts`, and the mobile
  scheduled-run surface: not built.
- Deferred to ride the relay deploy (P0 [HUMAN] item) — like the leaderboard
  ingest, it's a relay-worker addition, best built and deployed together.

## [HUMAN] before launch

- Decide the default schedule cadence UI (cron string vs. presets).
- The relay deploy + a `crons` entry in `wrangler.toml`.
