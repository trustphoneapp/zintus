/**
 * Idle watchdog for async event streams (matrix #15 note: a stalled upstream
 * previously hung `zintus research` until Ctrl-C). Wraps an AsyncIterable and
 * throws IdleTimeoutError when NO event arrives for `idleMs` — a per-gap
 * timeout, not a total-duration cap, so long runs that keep emitting are fine.
 */
export class IdleTimeoutError extends Error {
  constructor(idleMs: number) {
    super(
      `no progress for ${Math.round(idleMs / 1000)}s — the upstream appears stalled`,
    );
    this.name = "IdleTimeoutError";
  }
}

export async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  idleMs: number,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const gap = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new IdleTimeoutError(idleMs)), idleMs);
      });
      let result: IteratorResult<T>;
      try {
        result = await Promise.race([iterator.next(), gap]);
      } finally {
        clearTimeout(timer);
      }
      if (result.done) return;
      yield result.value;
    }
  } finally {
    // Ask the source to stop — FIRE AND FORGET. An async generator's return()
    // queues behind its pending next(), which is exactly the operation that
    // stalled; awaiting it here would block our own exit on the stall.
    void iterator.return?.().catch(() => undefined);
  }
}
