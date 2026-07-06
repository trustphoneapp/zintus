// Slow SSE upstream: 20 chunks, 400ms apart (8s total).
Bun.serve({
  port: 9999,
  async fetch() {
    return new Response(new ReadableStream({
      async start(c) {
        for (let i = 0; i < 20; i++) {
          c.enqueue(new TextEncoder().encode(`data: {"i":${i}}\n\n`));
          await new Promise((r) => setTimeout(r, 400));
        }
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
  },
});
console.log("upstream on :9999");
