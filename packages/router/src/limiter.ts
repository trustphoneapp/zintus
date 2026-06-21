const MAX_PER_MINUTE = 60;
const MAX_CONCURRENT = 10;
const WINDOW_MS = 60_000;

export class ZintusRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZintusRateLimitError";
  }
}

export class LocalRateLimiter {
  private timestamps: number[] = [];
  private concurrentCount = 0;

  acquire(): void {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < WINDOW_MS);

    if (this.timestamps.length >= MAX_PER_MINUTE) {
      const retryInMs = this.timestamps[0]! + WINDOW_MS - now;
      throw new ZintusRateLimitError(
        `Rate limit: max ${MAX_PER_MINUTE} requests/min. Retry in ${Math.ceil(retryInMs / 1000)}s.`,
      );
    }
    if (this.concurrentCount >= MAX_CONCURRENT) {
      throw new ZintusRateLimitError(
        `Concurrency limit: max ${MAX_CONCURRENT} simultaneous requests.`,
      );
    }

    this.timestamps.push(now);
    this.concurrentCount++;
  }

  release(): void {
    this.concurrentCount = Math.max(0, this.concurrentCount - 1);
  }
}

export const globalLimiter = new LocalRateLimiter();
