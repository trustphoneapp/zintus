import { describe, expect, test } from "bun:test";
import { PasswordResetService } from "../src/password-reset.js";

describe("secure password reset", () => {
  test("tokens expire after 15 minutes", () => {
    const service = new PasswordResetService();
    const issued = service.request("user-1", 1_000);
    expect(service.consume(issued.token!, 1_000 + 15 * 60_000)).toBeNull();
  });

  test("tokens are single use", () => {
    const service = new PasswordResetService();
    const issued = service.request("user-1", 1_000);
    expect(service.consume(issued.token!, 2_000)).toBe("user-1");
    expect(service.consume(issued.token!, 3_000)).toBeNull();
  });

  test("request responses do not reveal account existence and are rate limited", () => {
    const service = new PasswordResetService();
    const messages = [0, 1, 2, 3].map((offset) => service.request("user-1", 1_000 + offset).message);
    expect(new Set(messages)).toEqual(new Set(["If the account exists, reset instructions will be sent."]));
    expect(service.request("user-1", 1_005).token).toBeUndefined();
  });
});
