export function isInCooldown(
  cooldownUntil: number | null | undefined,
  now = Date.now(),
): boolean {
  return cooldownUntil != null && cooldownUntil > now;
}

export function computeCooldownMs(retries: number): number {
  const base = 30_000 * 2 ** Math.max(retries, 0);
  return Math.min(base, 1_800_000);
}
