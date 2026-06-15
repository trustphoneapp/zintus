export function parseGroqResetHeader(
  resetHeader: string,
  now = Date.now(),
): number {
  const trimmed = resetHeader.trim().toLowerCase();

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return now + Number.parseFloat(trimmed) * 1_000;
  }

  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(trimmed);
  if (!match) {
    return now + 60_000;
  }

  const amount = Number.parseFloat(match[1]!);
  const unit = match[2];

  switch (unit) {
    case "ms":
      return now + amount;
    case "m":
      return now + amount * 60_000;
    case "h":
      return now + amount * 3_600_000;
    case "s":
    default:
      return now + amount * 1_000;
  }
}
