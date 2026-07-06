# Stream-disconnect metering probe (pre-launch blocker sign-off)

Verifies IN WORKERD (the real runtime) that streamed usage is metered on
both normal completion and mid-stream client disconnect — the pattern
`src/managed.ts` uses. Run:

    bun upstream.js &                 # slow SSE upstream on :9999
    bunx wrangler dev --port 8789 &   # the probe worker
    curl -s --max-time 2 localhost:8789/ -o /dev/null   # abort mid-stream
    sleep 3 && curl -s localhost:8789/metered
    # expect: {"metered":[{"how":"client-abort","chunks":N}]}
    curl -s --max-time 15 localhost:8789/ -o /dev/null  # full stream
    curl -s localhost:8789/metered
    # expect: ... {"how":"complete","chunks":21}

Verified 2026-07-06: IdentityTransformStream propagates client cancellation
to the pending writer.write(); a plain JS TransformStream does NOT (the
write hangs forever and metering is lost — the pre-fix relay bug).
