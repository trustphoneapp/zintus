import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { sha256 } from "./hash.js";

const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const WarmSandboxDescriptorSchema = z.object({
  warmSandboxId: z.string().min(1).max(200),
  warmKey: HashSchema,
  repositoryId: z.string().min(1).max(200),
  repositoryRoot: z.string().min(1).max(4_000),
  workspaceRoot: z.string().min(1).max(4_000),
  originUrl: z.string().max(4_000).nullable(),
  baseCommitSha: z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i),
  imageDigest: HashSchema,
  lockfileHash: HashSchema,
  toolchainHash: HashSchema,
  networkPolicyVersion: z.string().min(1).max(100),
  sandboxPolicyVersion: z.string().min(1).max(100),
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

export type WarmSandboxDescriptor = z.infer<typeof WarmSandboxDescriptorSchema>;
export type WarmSandboxKey = Pick<WarmSandboxDescriptor,
  "repositoryId" | "baseCommitSha" | "imageDigest" | "lockfileHash" | "toolchainHash" |
  "networkPolicyVersion" | "sandboxPolicyVersion">;

export function warmSandboxKey(input: WarmSandboxKey): string {
  return sha256({
    repositoryId: input.repositoryId,
    baseCommitSha: input.baseCommitSha,
    imageDigest: input.imageDigest,
    lockfileHash: input.lockfileHash,
    toolchainHash: input.toolchainHash,
    networkPolicyVersion: input.networkPolicyVersion,
    sandboxPolicyVersion: input.sandboxPolicyVersion,
  });
}

export function workspaceLockfileHash(workspaceRoot: string): string {
  const files = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "poetry.lock"];
  const entries = files
    .filter((file) => existsSync(join(workspaceRoot, file)))
    .map((file) => ({ file, bytes: readFileSync(join(workspaceRoot, file)).toString("base64") }));
  return sha256(entries.length > 0 ? entries : "NO_LOCKFILE");
}

export interface WarmSandboxPoolOptions {
  root: string;
  now?: () => Date;
  idFactory?: () => string;
}

/** Filesystem-backed atomic warm claim registry. Claimed workspaces are never returned. */
export class WarmSandboxPool {
  private readonly root: string;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(options: WarmSandboxPoolOptions) {
    this.root = resolve(options.root);
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    for (const name of ["available", "claimed", "quarantined"]) {
      mkdirSync(join(this.root, name), { recursive: true, mode: 0o700 });
    }
  }

  register(input: Omit<WarmSandboxDescriptor, "warmSandboxId" | "warmKey">): WarmSandboxDescriptor {
    const descriptor = WarmSandboxDescriptorSchema.parse({
      ...input,
      warmSandboxId: this.idFactory(),
      warmKey: warmSandboxKey(input),
    });
    writeFileSync(this.path("available", descriptor.warmSandboxId), JSON.stringify(descriptor), {
      flag: "wx", mode: 0o600,
    });
    return descriptor;
  }

  claim(expected: WarmSandboxKey): WarmSandboxDescriptor | null {
    const expectedKey = warmSandboxKey(expected);
    for (const file of readdirSync(join(this.root, "available")).filter((name) => name.endsWith(".json")).sort()) {
      const available = join(this.root, "available", file);
      let descriptor: WarmSandboxDescriptor;
      try {
        descriptor = WarmSandboxDescriptorSchema.parse(JSON.parse(readFileSync(available, "utf8")));
      } catch {
        this.renameBestEffort(available, join(this.root, "quarantined", file));
        continue;
      }
      if (descriptor.warmKey !== expectedKey) continue;
      if (new Date(descriptor.expiresAt).getTime() <= this.now().getTime()) {
        this.renameBestEffort(available, join(this.root, "quarantined", file));
        continue;
      }
      const claimed = join(this.root, "claimed", file);
      try {
        renameSync(available, claimed);
        return descriptor;
      } catch {
        continue;
      }
    }
    return null;
  }

  quarantine(descriptor: WarmSandboxDescriptor): void {
    this.renameBestEffort(
      this.path("claimed", descriptor.warmSandboxId),
      this.path("quarantined", descriptor.warmSandboxId),
    );
  }

  private path(state: "available" | "claimed" | "quarantined", id: string): string {
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(id)) throw new TypeError("unsafe warm sandbox id");
    return join(this.root, state, `${id}.json`);
  }

  private renameBestEffort(from: string, to: string): void {
    try { renameSync(from, to); } catch { /* another claimant won or already quarantined */ }
  }
}
