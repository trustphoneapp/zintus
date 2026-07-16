import { describe, expect, test } from "bun:test";
import { EngineerActionLock } from "./engineer-action-lock";

describe("Engineer synchronous action lock", () => {
  test("admits only one same-tick control-plane request", async () => {
    const lock = new EngineerActionLock();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const first = lock.run("run-control", async () => { calls += 1; await blocked; return "done"; });
    const duplicate = await lock.run("run-control", async () => { calls += 1; return "duplicate"; });
    expect(duplicate).toEqual({ started: false });
    expect(calls).toBe(1);
    expect(lock.isActive("run-control")).toBe(true);
    release();
    expect(await first).toEqual({ started: true, value: "done" });
    expect(lock.isActive("run-control")).toBe(false);
  });

  test("releases after failure so an explicit retry can start", async () => {
    const lock = new EngineerActionLock();
    await expect(lock.run("run-control", async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    expect((await lock.run("run-control", async () => "retry")).started).toBe(true);
  });
});
