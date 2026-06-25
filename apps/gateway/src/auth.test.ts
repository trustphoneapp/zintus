import { describe, expect, test } from "bun:test";
import {
  bearerAuthorized,
  buildGatewayConfig,
  parseCorsOrigins,
  resolveCorsOrigin,
  timingSafeEqual,
} from "./auth.js";

describe("bearerAuthorized", () => {
  test("allows any request when no token is configured", () => {
    expect(bearerAuthorized(null, "")).toBe(true);
    expect(bearerAuthorized("Bearer whatever", "")).toBe(true);
  });

  test("requires a matching bearer token when configured", () => {
    expect(bearerAuthorized("Bearer secret", "secret")).toBe(true);
    expect(bearerAuthorized("Bearer wrong", "secret")).toBe(false);
    expect(bearerAuthorized(null, "secret")).toBe(false);
    expect(bearerAuthorized("secret", "secret")).toBe(false);
  });
});

describe("timingSafeEqual", () => {
  test("compares strings for equality", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});

describe("CORS parsing", () => {
  test("treats empty/star as wildcard", () => {
    expect(parseCorsOrigins(undefined)).toBe("*");
    expect(parseCorsOrigins("")).toBe("*");
    expect(parseCorsOrigins("*")).toBe("*");
  });

  test("parses a comma-separated allowlist", () => {
    expect(parseCorsOrigins("https://a.com, https://b.com")).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });

  test("only echoes allowlisted origins", () => {
    const origins = ["https://a.com"];
    expect(resolveCorsOrigin(origins, "https://a.com")).toBe("https://a.com");
    expect(resolveCorsOrigin(origins, "https://evil.com")).toBeNull();
    expect(resolveCorsOrigin("*", "https://anything.com")).toBe("*");
  });
});

describe("buildGatewayConfig", () => {
  test("defaults to loopback with auth disabled", () => {
    const config = buildGatewayConfig({} as NodeJS.ProcessEnv);
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8788);
    expect(config.token).toBe("");
  });

  test("refuses to bind publicly without a token", () => {
    expect(() =>
      buildGatewayConfig({ GATEWAY_HOST: "0.0.0.0" } as NodeJS.ProcessEnv),
    ).toThrow(/GATEWAY_TOKEN/);
  });

  test("allows a public bind once a token is set", () => {
    const config = buildGatewayConfig({
      GATEWAY_HOST: "0.0.0.0",
      GATEWAY_TOKEN: "secret",
    } as NodeJS.ProcessEnv);
    expect(config.host).toBe("0.0.0.0");
    expect(config.token).toBe("secret");
  });

  test("rejects an invalid port", () => {
    expect(() =>
      buildGatewayConfig({ GATEWAY_PORT: "70000" } as NodeJS.ProcessEnv),
    ).toThrow(/Invalid GATEWAY_PORT/);
  });

  test("defaults the stream idle watchdog to 60s and allows 0 to disable it", () => {
    const def = buildGatewayConfig({} as NodeJS.ProcessEnv);
    expect(def.streamIdleTimeoutMs).toBe(60_000);

    const disabled = buildGatewayConfig({
      GATEWAY_STREAM_IDLE_TIMEOUT_MS: "0",
    } as NodeJS.ProcessEnv);
    expect(disabled.streamIdleTimeoutMs).toBe(0);

    const custom = buildGatewayConfig({
      GATEWAY_STREAM_IDLE_TIMEOUT_MS: "5000",
    } as NodeJS.ProcessEnv);
    expect(custom.streamIdleTimeoutMs).toBe(5000);
  });

  test("rejects a negative stream idle timeout", () => {
    expect(() =>
      buildGatewayConfig({
        GATEWAY_STREAM_IDLE_TIMEOUT_MS: "-1",
      } as NodeJS.ProcessEnv),
    ).toThrow(/Invalid GATEWAY_STREAM_IDLE_TIMEOUT_MS/);
  });
});
