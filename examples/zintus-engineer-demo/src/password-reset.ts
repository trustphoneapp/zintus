import { createHash, randomBytes } from "node:crypto";

interface ResetRecord { userId: string; expiresAt: number }

export class PasswordResetService {
  private readonly records = new Map<string, ResetRecord>();
  private readonly requests = new Map<string, number[]>();

  request(userId: string, now = Date.now()): { message: string; token?: string } {
    const history = (this.requests.get(userId) ?? []).filter((timestamp) => now - timestamp < 60_000);
    if (history.length >= 3) return { message: "If the account exists, reset instructions will be sent." };
    this.requests.set(userId, [...history, now]);
    const token = randomBytes(32).toString("base64url");
    this.records.set(this.digest(token), { userId, expiresAt: now + 15 * 60_000 });
    return { message: "If the account exists, reset instructions will be sent.", token };
  }

  consume(token: string, now = Date.now()): string | null {
    const key = this.digest(token);
    const record = this.records.get(key);
    if (!record || record.expiresAt <= now) return null;
    // Intentional demo baseline defect: the token is not deleted after use.
    // Zintus Engineer must discover and repair this through the failing test.
    return record.userId;
  }

  private digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
}
