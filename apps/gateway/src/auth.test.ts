import { describe, expect, test } from "bun:test";
import {
  bearerAuthorized,
  buildGatewayConfig,
  isLoopbackHost,
  parseCorsOrigins,
  resolveCorsOrigin,
  resolveDefaultCors,
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

  test("refuses a LAN-IP bind without a token (denial-of-wallet hardening)", () => {
    // The pre-fix guard only caught 0.0.0.0/:: — a LAN IP slipped through and
    // left a tokenless gateway open to no-Origin LAN clients.
    for (const host of ["192.168.1.5", "10.0.0.2", "172.16.4.4"]) {
      expect(() =>
        buildGatewayConfig({ GATEWAY_HOST: host } as NodeJS.ProcessEnv),
      ).toThrow(/GATEWAY_TOKEN/);
    }
  });

  test("allows a LAN-IP bind once a token is set", () => {
    const config = buildGatewayConfig({
      GATEWAY_HOST: "192.168.1.5",
      GATEWAY_TOKEN: "secret",
    } as NodeJS.ProcessEnv);
    expect(config.host).toBe("192.168.1.5");
    expect(config.token).toBe("secret");
  });

  test("allows loopback hosts without a token (localhost / 127.x / ::1)", () => {
    for (const host of ["127.0.0.1", "localhost", "127.0.0.5", "::1", "[::1]"]) {
      const config = buildGatewayConfig({
        GATEWAY_HOST: host,
      } as NodeJS.ProcessEnv);
      expect(config.host).toBe(host);
      expect(config.token).toBe("");
    }
  });

  test("refuses a hostname bind without a token", () => {
    expect(() =>
      buildGatewayConfig({ GATEWAY_HOST: "gateway.local" } as NodeJS.ProcessEnv),
    ).toThrow(/GATEWAY_TOKEN/);
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

  test("CORS default: loopback when tokenless, * when a token is set", () => {
    expect(buildGatewayConfig({} as NodeJS.ProcessEnv).corsOrigins).toBe(
      "loopback",
    );
    expect(
      buildGatewayConfig({ GATEWAY_TOKEN: "secret" } as NodeJS.ProcessEnv)
        .corsOrigins,
    ).toBe("*");
    expect(
      buildGatewayConfig({
        GATEWAY_CORS_ORIGIN: "https://app.example.com",
      } as NodeJS.ProcessEnv).corsOrigins,
    ).toEqual(["https://app.example.com"]);
  });
});

describe("isLoopbackHost", () => {
  test("true only for localhost / 127.0.0.0/8 / ::1", () => {
    for (const h of [
      "localhost",
      "127.0.0.1",
      "127.5.6.7",
      "::1",
      "[::1]",
      "0:0:0:0:0:0:0:1",
    ]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
    for (const h of [
      "0.0.0.0",
      "::",
      "192.168.1.5",
      "10.0.0.1",
      "172.16.0.9",
      "8.8.8.8",
      "gateway.local",
      "example.com",
    ]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});

describe("loopback CORS (tokenless gateway hardening)", () => {
  test("resolveDefaultCors: explicit wins, else token→* / tokenless→loopback", () => {
    expect(resolveDefaultCors(undefined, "")).toBe("loopback");
    expect(resolveDefaultCors("", "")).toBe("loopback");
    expect(resolveDefaultCors(undefined, "secret")).toBe("*");
    expect(resolveDefaultCors("*", "")).toBe("*");
    expect(resolveDefaultCors("https://x.com", "")).toEqual(["https://x.com"]);
  });

  test("loopback allows localhost (any port), tauri, official web; denies others", () => {
    expect(resolveCorsOrigin("loopback", "http://localhost:3000")).toBe(
      "http://localhost:3000",
    );
    expect(resolveCorsOrigin("loopback", "http://127.0.0.1:5173")).toBe(
      "http://127.0.0.1:5173",
    );
    expect(resolveCorsOrigin("loopback", "tauri://localhost")).toBe(
      "tauri://localhost",
    );
    expect(resolveCorsOrigin("loopback", "https://www.zintus.ai")).toBe(
      "https://www.zintus.ai",
    );
    expect(resolveCorsOrigin("loopback", "https://evil.com")).toBeNull();
    expect(resolveCorsOrigin("loopback", null)).toBeNull();
  });
});
