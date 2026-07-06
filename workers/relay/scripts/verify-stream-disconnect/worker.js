// FIX pattern: manual pump through a TransformStream; client cancel makes
// writer.write reject -> cancel upstream -> meter in finally. Metering must
// fire on BOTH normal completion and mid-stream client abort.
let metered = [];
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/metered") return Response.json({ metered });

    const upstream = await fetch("http://localhost:9999/sse");
    let chunks = 0;
    let clientGone = false;
    const { readable, writable } = new IdentityTransformStream();
    const writer = writable.getWriter();
    const pump = (async () => {
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks++;
          try {
            await writer.write(value);
          } catch {
            clientGone = true;
            await reader.cancel().catch(() => {});
            break;
          }
        }
      } finally {
        try { await writer.close(); } catch {}
        metered.push({ how: clientGone ? "client-abort" : "complete", chunks });
      }
    })();
    ctx.waitUntil(pump.catch(() => {}));
    return new Response(readable, { headers: { "Content-Type": "text/event-stream" } });
  },
};
