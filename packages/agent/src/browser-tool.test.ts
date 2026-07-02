import { describe, expect, test } from "bun:test";
import {
  blockedHostReason,
  browserToolDefinition,
  executeBrowseCall,
  makePublicHostGuard,
  resolveAndVetHost,
  type BrowserDriver,
  type HostLookup,
} from "./browser-tool.js";

const fakeDriver: BrowserDriver = {
  async fetchPage(req) {
    return {
      url: req.url,
      finalUrl: req.url,
      title: "Example",
      content: req.extract === "html" ? "<p>hi</p>" : "hi there",
      truncated: false,
    };
  },
};

/** Fake DNS: every name resolves to the given addresses (never the network). */
function fakeLookup(...addresses: string[]): HostLookup {
  return async () =>
    addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
}

const publicLookup = fakeLookup("93.184.216.34");

describe("browser tool (P3)", () => {
  test("definition requires a url", () => {
    expect(browserToolDefinition.name).toBe("browse");
    expect(browserToolDefinition.parameters.required).toContain("url");
  });

  test("refuses honestly when no driver is wired (graceful absence)", async () => {
    const r = await executeBrowseCall(
      { id: "1", arguments: { url: "https://example.com" } },
      undefined,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not available");
  });

  test("rejects a non-http(s) url without touching the driver", async () => {
    let touched = false;
    const driver: BrowserDriver = {
      async fetchPage() {
        touched = true;
        return { url: "", finalUrl: "", title: "" };
      },
    };
    const r = await executeBrowseCall(
      { id: "1", arguments: { url: "file:///etc/passwd" } },
      driver,
    );
    expect(r.isError).toBe(true);
    expect(touched).toBe(false);
  });

  test("returns page content via the driver", async () => {
    const r = await executeBrowseCall(
      { id: "1", arguments: { url: "https://example.com" } },
      fakeDriver,
      { lookup: publicLookup },
    );
    expect(r.isError).toBe(false);
    const body = JSON.parse(r.content) as { title: string; content: string };
    expect(body.title).toBe("Example");
    expect(body.content).toBe("hi there");
  });

  describe("SSRF guard (blockedHostReason)", () => {
    test("blocks loopback, private, link-local, and metadata targets", () => {
      for (const h of [
        "localhost",
        "app.local",
        "svc.internal",
        "metadata.google.internal",
        "127.0.0.1",
        "0.0.0.0",
        "10.0.0.5",
        "172.16.9.9",
        "172.31.255.255",
        "192.168.1.1",
        "169.254.169.254", // cloud metadata
        "::1",
        "fe80::1",
        "fd00::1",
        "fc00::1",
      ]) {
        expect(blockedHostReason(h), `${h} should be blocked`).not.toBeNull();
      }
    });

    test("allows ordinary public hosts and public IPs", () => {
      for (const h of ["example.com", "api.openai.com", "8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1"]) {
        expect(blockedHostReason(h), `${h} should be allowed`).toBeNull();
      }
    });
  });

  test("refuses a private URL by default (SSRF), and allows it with allowPrivate", async () => {
    let touched = false;
    const driver: BrowserDriver = {
      async fetchPage() {
        touched = true;
        return { url: "", finalUrl: "", title: "" };
      },
    };
    const blocked = await executeBrowseCall(
      { id: "1", arguments: { url: "http://169.254.169.254/latest/meta-data/" } },
      driver,
    );
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain("SSRF");
    expect(touched).toBe(false);

    const allowed = await executeBrowseCall(
      { id: "2", arguments: { url: "http://127.0.0.1:3000/" } },
      driver,
      { allowPrivate: true },
    );
    expect(allowed.isError).toBe(false);
    expect(touched).toBe(true);
  });

  test("surfaces a driver failure as an honest error, never throws", async () => {
    const boom: BrowserDriver = {
      async fetchPage() {
        throw new Error("navigation failed");
      },
    };
    const r = await executeBrowseCall(
      { id: "1", arguments: { url: "https://example.com" } },
      boom,
      { lookup: publicLookup },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("navigation failed");
  });

  describe("DNS-rebinding guard (resolve-then-pin)", () => {
    test("refuses a public name that resolves to a private address", async () => {
      let touched = false;
      const driver: BrowserDriver = {
        async fetchPage() {
          touched = true;
          return { url: "", finalUrl: "", title: "" };
        },
      };
      const r = await executeBrowseCall(
        { id: "1", arguments: { url: "https://rebind.attacker.example" } },
        driver,
        { lookup: fakeLookup("127.0.0.1") },
      );
      expect(r.isError).toBe(true);
      expect(r.content).toContain("rebinding");
      expect(touched).toBe(false);
    });

    test("refuses when ANY record is private (mixed answers)", async () => {
      const r = await executeBrowseCall(
        { id: "1", arguments: { url: "https://mixed.example" } },
        fakeDriver,
        { lookup: fakeLookup("93.184.216.34", "10.0.0.5") },
      );
      expect(r.isError).toBe(true);
      expect(r.content).toContain("rebinding");
    });

    test("fails closed when the name does not resolve", async () => {
      const r = await executeBrowseCall(
        { id: "1", arguments: { url: "https://nx.example" } },
        fakeDriver,
        {
          lookup: async () => {
            throw new Error("ENOTFOUND");
          },
        },
      );
      expect(r.isError).toBe(true);
      expect(r.content).toContain("did not resolve");
    });

    test("pins the vetted address into the driver request (IPv4 preferred)", async () => {
      let pinned: { hostname: string; address: string } | undefined;
      const driver: BrowserDriver = {
        async fetchPage(req) {
          pinned = req.pin;
          return { url: req.url, finalUrl: req.url, title: "ok" };
        },
      };
      const r = await executeBrowseCall(
        { id: "1", arguments: { url: "https://Example.COM/page" } },
        driver,
        { lookup: fakeLookup("2606:2800::1", "93.184.216.34") },
      );
      expect(r.isError).toBe(false);
      expect(pinned).toEqual({ hostname: "example.com", address: "93.184.216.34" });
    });

    test("literal public IPs skip resolution and get no pin", async () => {
      let pinned: unknown = "unset";
      const driver: BrowserDriver = {
        async fetchPage(req) {
          pinned = req.pin;
          return { url: req.url, finalUrl: req.url, title: "ok" };
        },
      };
      const r = await executeBrowseCall(
        { id: "1", arguments: { url: "http://8.8.8.8/" } },
        driver,
        {
          lookup: async () => {
            throw new Error("lookup must not be called for literal IPs");
          },
        },
      );
      expect(r.isError).toBe(false);
      expect(pinned).toBeUndefined();
    });

    test("allowPrivate skips resolution entirely", async () => {
      let looked = false;
      const r = await executeBrowseCall(
        { id: "1", arguments: { url: "http://anything.example/" } },
        fakeDriver,
        {
          allowPrivate: true,
          lookup: async () => {
            looked = true;
            return [{ address: "127.0.0.1", family: 4 }];
          },
        },
      );
      expect(r.isError).toBe(false);
      expect(looked).toBe(false);
    });

    test("resolveAndVetHost vets every address and prefers IPv4 for the pin", async () => {
      const bad = await resolveAndVetHost("x.example", fakeLookup("192.168.1.1"));
      expect(bad.reason).toContain("rebinding");
      const ok = await resolveAndVetHost(
        "x.example",
        fakeLookup("2606:2800::1", "1.2.3.4"),
      );
      expect(ok.reason).toBeNull();
      expect(ok.address).toBe("1.2.3.4");
    });

    test("makePublicHostGuard blocks by name, blocks private-resolving names, allows public, and memoizes", async () => {
      let calls = 0;
      const guard = makePublicHostGuard(async () => {
        calls++;
        return [{ address: "93.184.216.34", family: 4 }];
      });
      expect(await guard("localhost")).not.toBeNull();
      expect(await guard("169.254.169.254")).not.toBeNull();
      expect(await guard("ok.example")).toBeNull();
      expect(await guard("ok.example")).toBeNull();
      expect(calls).toBe(1); // memoized

      const evil = makePublicHostGuard(fakeLookup("10.1.1.1"));
      expect(await evil("redirect-target.example")).toContain("rebinding");
    });
  });
});
