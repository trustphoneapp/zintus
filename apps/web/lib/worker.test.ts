import { afterEach, describe, expect, it } from "bun:test";
import { getValidateWorkerUrl } from "./worker";

describe("validate worker URL", () => {
  const originalWorkerValidateUrl = process.env.WORKER_VALIDATE_URL;
  const originalValidateWorkerUrl = process.env.VALIDATE_WORKER_URL;

  afterEach(() => {
    if (originalWorkerValidateUrl === undefined) {
      delete process.env.WORKER_VALIDATE_URL;
    } else {
      process.env.WORKER_VALIDATE_URL = originalWorkerValidateUrl;
    }
    if (originalValidateWorkerUrl === undefined) {
      delete process.env.VALIDATE_WORKER_URL;
    } else {
      process.env.VALIDATE_WORKER_URL = originalValidateWorkerUrl;
    }
  });

  it("prefers WORKER_VALIDATE_URL", () => {
    process.env.WORKER_VALIDATE_URL = "https://validate.example.com/validate";
    process.env.VALIDATE_WORKER_URL = "https://ignored.example.com";
    expect(getValidateWorkerUrl()).toBe("https://validate.example.com/validate");
  });

  it("falls back to VALIDATE_WORKER_URL", () => {
    delete process.env.WORKER_VALIDATE_URL;
    process.env.VALIDATE_WORKER_URL = "https://fallback.example.com/validate";
    expect(getValidateWorkerUrl()).toBe("https://fallback.example.com/validate");
  });

  it("defaults to local wrangler dev URL", () => {
    delete process.env.WORKER_VALIDATE_URL;
    delete process.env.VALIDATE_WORKER_URL;
    expect(getValidateWorkerUrl()).toBe("http://127.0.0.1:8787/validate");
  });
});
