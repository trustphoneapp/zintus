import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyGatewayDotenv, parseDotenv } from "./dotenv.js";

describe("parseDotenv", () => {
  test("parses KEY=VALUE, skips comments/blank/malformed lines", () => {
    expect(
      parseDotenv(
        [
          "# comment",
          "",
          "TAVILY_API_KEY=tvly-abc",
          "QUOTED=\"with spaces\"",
          "SINGLE='sq'",
          "TRAILING = padded ",
          "=novalue",
          "justtext",
        ].join("\n"),
      ),
    ).toEqual({
      TAVILY_API_KEY: "tvly-abc",
      QUOTED: "with spaces",
      SINGLE: "sq",
      TRAILING: "padded",
    });
  });

  test("keeps '=' inside values", () => {
    expect(parseDotenv("K=a=b=c")).toEqual({ K: "a=b=c" });
  });
});

describe("applyGatewayDotenv", () => {
  test("fills unset/empty keys only — real env always wins", () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-dotenv-"));
    writeFileSync(
      join(dir, ".env"),
      "TAVILY_API_KEY=from-file\nOTHER_KEY=file-val\n",
    );
    const env: NodeJS.ProcessEnv = { TAVILY_API_KEY: "from-shell", EMPTY: "" };
    writeFileSync(join(dir, ".env"), "TAVILY_API_KEY=from-file\nEMPTY=filled\nNEW=n\n");
    const loaded = applyGatewayDotenv(env, dir);
    expect(loaded).toBe(join(dir, ".env"));
    expect(env.TAVILY_API_KEY).toBe("from-shell"); // precedence: env first
    expect(env.EMPTY).toBe("filled"); // empty counts as unset
    expect(env.NEW).toBe("n");
  });

  test("no .env file → no-op, returns null", () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-dotenv-none-"));
    const env: NodeJS.ProcessEnv = { A: "1" };
    expect(applyGatewayDotenv(env, dir)).toBeNull();
    expect(env).toEqual({ A: "1" });
  });
});
