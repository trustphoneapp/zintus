import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EngineerWorkerLeaseManager,
  StaleWorkerLeaseError,
  WorkerLeaseCapacityError,
  WorkerLeaseConflictError,
  WorkerLeaseIdempotencyError,
  WorkerLeaseRenewalLimitError,
  type WorkerLeaseRecord,
} from "./worker-lease.js";

const SECRET = "worker-lease-test-secret-that-is-at-least-thirty-two-bytes";

function fixture(options: {
  maxConcurrentLeases?: number;
  maxRenewals?: number;
  maxRecoveryAttempts?: number;
  recoverExpiredLease?: (lease: WorkerLeaseRecord) => void | Promise<void>;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "zintus-worker-lease-"));
  const dbPath = join(root, "engineer.db");
  let now = new Date("2026-07-14T12:00:00.000Z");
  let sequence = 0;
  const create = () => new EngineerWorkerLeaseManager({
    dbPath,
    tokenSecret: SECRET,
    maxConcurrentLeases: options.maxConcurrentLeases ?? 2,
    ...(options.maxRenewals === undefined ? {} : { maxRenewals: options.maxRenewals }),
    maxRecoveryAttempts: options.maxRecoveryAttempts ?? 3,
    now: () => now,
    idFactory: () => `lease-${++sequence}`,
    recoverExpiredLease: options.recoverExpiredLease ?? (() => undefined),
  });
  return {
    root,
    dbPath,
    create,
    advance(ms: number) { now = new Date(now.getTime() + ms); },
    close(...managers: EngineerWorkerLeaseManager[]) {
      for (const manager of managers) manager.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function command(grant: ReturnType<EngineerWorkerLeaseManager["acquire"]>, idempotencyKey: string) {
  return {
    leaseId: grant.lease.leaseId,
    ownerId: grant.lease.ownerId,
    fencingToken: grant.lease.fencingToken,
    leaseToken: grant.leaseToken,
    idempotencyKey,
  };
}

describe("durable Engineer worker leases", () => {
  test("the default renewal bound exceeds a one-hour execution budget at ten-second heartbeats", () => {
    const item = fixture();
    const manager = item.create();
    const grant = manager.acquire({ resourceKey: "run-hour", ownerId: "worker-a", ttlMs: 30_000, idempotencyKey: "acquire" });
    expect(grant.lease.maxRenewals).toBeGreaterThanOrEqual(360);
    let renewed = grant.lease;
    for (let index = 1; index <= 360; index += 1) {
      item.advance(10_000);
      renewed = manager.heartbeat(command(grant, `heartbeat-${index}`));
    }
    expect(renewed).toMatchObject({ status: "ACTIVE", renewalCount: 360 });
    item.close(manager);
  });

  test("acquisition is durable, idempotent, resource-exclusive, and globally concurrency-bounded", () => {
    const item = fixture({ maxConcurrentLeases: 1 });
    const first = item.create();
    const acquired = first.acquire({ resourceKey: "run-1", ownerId: "worker-a", ttlMs: 5_000, idempotencyKey: "acquire-1" });
    expect(first.acquire({ resourceKey: "run-1", ownerId: "worker-a", ttlMs: 5_000, idempotencyKey: "acquire-1" })).toEqual(acquired);
    expect(() => first.acquire({ resourceKey: "run-1", ownerId: "worker-b", ttlMs: 5_000, idempotencyKey: "acquire-2" })).toThrow(WorkerLeaseConflictError);
    expect(() => first.acquire({ resourceKey: "run-2", ownerId: "worker-b", ttlMs: 5_000, idempotencyKey: "acquire-3" })).toThrow(WorkerLeaseCapacityError);
    expect(() => first.acquire({ resourceKey: "run-other", ownerId: "worker-a", ttlMs: 5_000, idempotencyKey: "acquire-1" })).toThrow(WorkerLeaseIdempotencyError);
    first.close();

    const reopened = item.create();
    expect(reopened.acquire({ resourceKey: "run-1", ownerId: "worker-a", ttlMs: 5_000, idempotencyKey: "acquire-1" })).toEqual(acquired);
    item.close(reopened);
  });

  test("owner, capability token, and monotonic fencing token reject stale workers", () => {
    const item = fixture({ maxRenewals: 2 });
    const manager = item.create();
    const first = manager.acquire({ resourceKey: "run-fenced", ownerId: "worker-a", ttlMs: 1_000, idempotencyKey: "acquire-a" });
    expect(() => manager.assertActive({ ...command(first, "unused"), ownerId: "worker-b" })).toThrow(StaleWorkerLeaseError);
    expect(() => manager.assertActive({ ...command(first, "unused"), leaseToken: `${first.leaseToken}x` })).toThrow(StaleWorkerLeaseError);
    expect(() => manager.assertActive({ ...command(first, "unused"), fencingToken: first.lease.fencingToken + 1 })).toThrow(StaleWorkerLeaseError);

    const heartbeat = manager.heartbeat(command(first, "heartbeat-1"));
    expect(heartbeat.renewalCount).toBe(1);
    expect(manager.heartbeat(command(first, "heartbeat-1"))).toEqual(heartbeat);
    expect(manager.heartbeat(command(first, "heartbeat-2")).renewalCount).toBe(2);
    expect(() => manager.heartbeat(command(first, "heartbeat-3"))).toThrow(WorkerLeaseRenewalLimitError);

    item.advance(1_001);
    expect(() => manager.assertActive(command(first, "unused"))).toThrow(StaleWorkerLeaseError);
    const second = manager.acquire({ resourceKey: "run-fenced", ownerId: "worker-b", ttlMs: 1_000, idempotencyKey: "acquire-b" });
    expect(second.lease.fencingToken).toBe(first.lease.fencingToken + 1);
    expect(() => manager.heartbeat(command(first, "late-heartbeat"))).toThrow(StaleWorkerLeaseError);
    expect(() => manager.heartbeat(command(first, "heartbeat-1"))).toThrow(StaleWorkerLeaseError);
    expect(manager.assertActive(command(second, "unused")).ownerId).toBe("worker-b");
    item.close(manager);
  });

  test("release is idempotent and immediately frees bounded capacity", () => {
    const item = fixture({ maxConcurrentLeases: 1 });
    const manager = item.create();
    const grant = manager.acquire({ resourceKey: "run-release", ownerId: "worker-a", ttlMs: 10_000, idempotencyKey: "acquire" });
    const released = manager.release(command(grant, "release"));
    expect(released.status).toBe("RELEASED");
    expect(manager.release(command(grant, "release"))).toEqual(released);
    expect(() => manager.release(command(grant, "another-release"))).toThrow(StaleWorkerLeaseError);
    expect(manager.acquire({ resourceKey: "run-next", ownerId: "worker-b", ttlMs: 10_000, idempotencyKey: "next" }).lease.status).toBe("ACTIVE");
    item.close(manager);
  });

  test("watchdog durably retries bounded recovery and stale workers remain fenced", async () => {
    let attempts = 0;
    const item = fixture({
      maxRecoveryAttempts: 2,
      recoverExpiredLease() {
        attempts += 1;
        if (attempts === 1) throw new Error("transient cleanup failure");
      },
    });
    const manager = item.create();
    const grant = manager.acquire({ resourceKey: "run-recover", ownerId: "worker-a", ttlMs: 1_000, idempotencyKey: "acquire" });
    item.advance(1_001);
    const firstSweep = await manager.watchdogSweep();
    expect(firstSweep).toEqual({ expiredLeaseIds: [grant.lease.leaseId], recoveredLeaseIds: [], failedLeaseIds: [] });
    expect(manager.get(grant.lease.leaseId)).toMatchObject({ status: "EXPIRED", recoveryStatus: "PENDING", recoveryAttempts: 1 });
    item.advance(1_000);
    const secondSweep = await manager.watchdogSweep();
    expect(secondSweep.recoveredLeaseIds).toEqual([grant.lease.leaseId]);
    expect(manager.get(grant.lease.leaseId)).toMatchObject({ recoveryStatus: "COMPLETED", recoveryAttempts: 2 });
    expect(() => manager.heartbeat(command(grant, "stale"))).toThrow(StaleWorkerLeaseError);
    const replacement = manager.acquire({ resourceKey: "run-recover", ownerId: "worker-b", ttlMs: 1_000, idempotencyKey: "replacement" });
    expect(replacement.lease.fencingToken).toBe(grant.lease.fencingToken + 1);
    item.close(manager);
  });

  test("watchdog attempts and batches are bounded, with only one recovery claimant", async () => {
    let calls = 0;
    const item = fixture({
      maxRecoveryAttempts: 2,
      recoverExpiredLease() { calls += 1; throw new Error("persistent cleanup failure"); },
    });
    const first = item.create();
    const second = item.create();
    const grant = first.acquire({ resourceKey: "run-watchdog", ownerId: "worker-a", ttlMs: 1_000, idempotencyKey: "acquire" });
    item.advance(1_001);
    await Promise.all([first.watchdogSweep(1), second.watchdogSweep(1)]);
    expect(calls).toBe(1);
    item.advance(1_000);
    const final = await first.watchdogSweep(1);
    expect(final.failedLeaseIds).toEqual([grant.lease.leaseId]);
    expect(first.get(grant.lease.leaseId)).toMatchObject({ recoveryStatus: "FAILED", recoveryAttempts: 2 });
    expect(calls).toBe(2);
    expect((await first.watchdogSweep(1)).failedLeaseIds).toEqual([]);
    expect(calls).toBe(2);
    item.close(first, second);
  });

  test("competing watchdogs cannot recover the same expired lease concurrently", async () => {
    let calls = 0;
    let beginRecovery!: () => void;
    let finishRecovery!: () => void;
    const started = new Promise<void>((resolve) => { beginRecovery = resolve; });
    const finish = new Promise<void>((resolve) => { finishRecovery = resolve; });
    const item = fixture({
      async recoverExpiredLease() {
        calls += 1;
        beginRecovery();
        await finish;
      },
    });
    const first = item.create();
    const second = item.create();
    first.acquire({ resourceKey: "run-concurrent-recovery", ownerId: "worker-a", ttlMs: 1_000, idempotencyKey: "acquire" });
    item.advance(1_001);
    const firstSweep = first.watchdogSweep(1);
    await started;
    expect(await second.watchdogSweep(1)).toEqual({ expiredLeaseIds: [], recoveredLeaseIds: [], failedLeaseIds: [] });
    expect(calls).toBe(1);
    finishRecovery();
    expect((await firstSweep).recoveredLeaseIds).toHaveLength(1);
    expect(calls).toBe(1);
    item.close(first, second);
  });

  test("durable stores reject inconsistent concurrency and token-secret configuration", () => {
    const item = fixture({ maxConcurrentLeases: 2 });
    const manager = item.create();
    expect(() => new EngineerWorkerLeaseManager({
      dbPath: item.dbPath, tokenSecret: SECRET, maxConcurrentLeases: 3, recoverExpiredLease: () => undefined,
    })).toThrow("concurrency configuration disagrees");
    expect(() => new EngineerWorkerLeaseManager({
      dbPath: item.dbPath, tokenSecret: "different-secret-that-is-also-at-least-thirty-two-bytes", maxConcurrentLeases: 2,
      recoverExpiredLease: () => undefined,
    })).toThrow("token secret disagrees");
    item.close(manager);
  });
});
