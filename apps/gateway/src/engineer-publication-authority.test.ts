import { describe, expect, test } from "bun:test";
import { canEnableEngineerPublication } from "./engineer-identity.js";

describe("Engineer publication startup authority", () => {
  test("requires gateway bearer authentication in addition to GitHub credentials", () => {
    expect(canEnableEngineerPublication({ publicationSecret: "signing", githubToken: "github", gatewayToken: "gateway" })).toBe(true);
    expect(canEnableEngineerPublication({ publicationSecret: "signing", githubToken: "github" })).toBe(false);
    expect(canEnableEngineerPublication({ publicationSecret: "signing", gatewayToken: "gateway" })).toBe(false);
    expect(canEnableEngineerPublication({ githubToken: "github", gatewayToken: "gateway" })).toBe(false);
    expect(canEnableEngineerPublication({ publicationSecret: " ", githubToken: "github", gatewayToken: "gateway" })).toBe(false);
  });
});
