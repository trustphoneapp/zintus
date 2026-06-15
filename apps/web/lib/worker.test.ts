import { afterEach, describe, expect, it, vi } from "vitest";
import { getValidateWorkerUrl } from "./worker";

describe("validate worker URL", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers WORKER_VALIDATE_URL", () => {
    vi.stubEnv("WORKER_VALIDATE_URL", "https://validate.example.com/validate");
    vi.stubEnv("VALIDATE_WORKER_URL", "https://ignored.example.com");
    expect(getValidateWorkerUrl()).toBe("https://validate.example.com/validate");
  });

  it("falls back to VALIDATE_WORKER_URL", () => {
    vi.stubEnv("VALIDATE_WORKER_URL", "https://fallback.example.com/validate");
    expect(getValidateWorkerUrl()).toBe("https://fallback.example.com/validate");
  });

  it("defaults to local wrangler dev URL", () => {
    expect(getValidateWorkerUrl()).toBe("http://127.0.0.1:8787/validate");
  });
});
