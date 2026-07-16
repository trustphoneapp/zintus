export class EngineerActionLock {
  private readonly active = new Set<string>();

  isActive(key: string): boolean { return this.active.has(key); }

  async run<T>(key: string, action: () => Promise<T>): Promise<{ started: true; value: T } | { started: false }> {
    if (this.active.has(key)) return { started: false };
    this.active.add(key);
    try {
      return { started: true, value: await action() };
    } finally {
      this.active.delete(key);
    }
  }
}
