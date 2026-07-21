# Failure matrix

| Failure | Required behavior | User-visible state |
| --- | --- | --- |
| Gateway unavailable | Stop polling with bounded retry | Gateway unavailable; actionable reconnect |
| Engineer preflight incomplete | No paid call | Exact failed prerequisite and corrective action |
| Missing OpenAI key | No model call | Missing credential, distinct from model capability |
| Invalid OpenAI key | Halt current provider action | Invalid credential; preserve run/checkpoint |
| Provider/network ambiguity | Do not replay automatically | Ambiguous spend/outcome, human-controlled continuation |
| Docker unavailable | No execution dispatch | Docker unavailable |
| Dependency bundle mismatch | No sandbox execution | Exact commit/hash mismatch |
| Repository/base mismatch | Freeze or route through Resolution Desk | Stale base with deterministic recovery action |
| Budget exhausted | Preserve partial verified work | Paused; settled vs reserved spend; explicit top-up |
| Cancellation | Revoke work and settle reservation | Cancelled with durable terminal event |
| Gateway restart | Reconcile durable state | Resumed or actionable recovery, never silent hang |
| Security/scope violation | Fail closed | Blocking policy finding |
| Advisory hardening | Do not invalidate satisfied frozen criteria | Ready for review plus optional recommendation |
| Missing GitHub credential | Keep local engineering usable | Publication unavailable only |
| Ambiguous PR create | Read-only provider discovery | Reconciled existing draft or human-required block |

No state may imply success without durable evidence, and no progress percentage may be fabricated.
