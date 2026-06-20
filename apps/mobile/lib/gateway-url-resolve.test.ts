import { describe, expect, it } from "bun:test";
import {
  devHostUrlFromScriptUrl,
  normalizeGatewayUrl,
  resolveGatewayUrl,
} from "./gateway-url-resolve";

describe("devHostUrlFromScriptUrl", () => {
  it("derives the dev host (LAN IP) with the gateway port", () => {
    expect(
      devHostUrlFromScriptUrl("http://192.168.1.5:8081/index.bundle?platform=ios"),
    ).toBe("http://192.168.1.5:8788");
  });

  it("keeps the Android emulator host alias", () => {
    expect(devHostUrlFromScriptUrl("http://10.0.2.2:8081/index.bundle")).toBe(
      "http://10.0.2.2:8788",
    );
  });

  it("rejects localhost/127.0.0.1 (the device itself) and production file URLs", () => {
    expect(devHostUrlFromScriptUrl("http://localhost:8081/index.bundle")).toBeNull();
    expect(devHostUrlFromScriptUrl("http://127.0.0.1:8081/index.bundle")).toBeNull();
    expect(devHostUrlFromScriptUrl("file:///var/app/main.jsbundle")).toBeNull();
    expect(devHostUrlFromScriptUrl(null)).toBeNull();
  });
});

describe("resolveGatewayUrl", () => {
  it("prefers a user-saved URL above everything else", () => {
    expect(
      resolveGatewayUrl({
        saved: "http://10.0.0.9:8788",
        env: "http://env-host:8788",
        scriptURL: "http://192.168.1.5:8081/index.bundle",
      }),
    ).toBe("http://10.0.0.9:8788");
  });

  it("falls back to env, then the dev host, then localhost", () => {
    expect(
      resolveGatewayUrl({ env: "http://env-host:8788/", scriptURL: null }),
    ).toBe("http://env-host:8788");
    expect(
      resolveGatewayUrl({ scriptURL: "http://192.168.1.5:8081/index.bundle" }),
    ).toBe("http://192.168.1.5:8788");
    expect(resolveGatewayUrl({ scriptURL: "file:///main.jsbundle" })).toBe(
      "http://localhost:8788",
    );
  });
});

describe("normalizeGatewayUrl", () => {
  it("trims whitespace and trailing slashes", () => {
    expect(normalizeGatewayUrl("  http://host:8788/// ")).toBe("http://host:8788");
  });
});
