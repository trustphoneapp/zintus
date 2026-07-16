import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { sha256, type EngineerSupervisor, type RepositoryAdmission, type RepositoryReference } from "@zintus/engineer";
import type { EngineerCanonicalRepository } from "./engineer-preflight.js";

export interface EngineerRepositoryAdmissionRegistry {
  primary(): RepositoryReference;
  list(): RepositoryReference[];
  require(repository: RepositoryReference): RepositoryReference;
  advanceBase(previousBaseCommitSha: string, repository: RepositoryReference): void;
  repositoryRoot(repositoryId: string): string;
}

export interface ConnectorRepositoryAuthorization {
  grantId: string;
  ownerUserId: string;
  connectorId: string;
  repository: RepositoryReference;
  repositoryRoot: string;
  evidenceHash: string;
  generation: number;
  expiresAt: string;
}

export interface DurableEngineerRepositoryAdmissionRegistryOptions {
  supervisor: EngineerSupervisor;
  ownerUserId: string;
  canonical: EngineerCanonicalRepository;
  canonicalRepositoryRoot: string;
  /** A server-side verifier for relay-signed/authenticated connector grants. */
  verifyConnectorAuthorization?: (grant: ConnectorRepositoryAuthorization) => boolean;
  now?: () => Date;
}

/** Resolve HEAD only for an owner-configured local checkout and exact branch. */
export function resolveLocalRepositoryHead(repositoryRoot: string, expectedBranch: string): string | null {
  try {
    const root = realpathSync(repositoryRoot);
    const branch = spawnSync("git", ["-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"], {
      shell: false, encoding: "utf8", timeout: 10_000,
    });
    if (branch.status !== 0 || branch.stdout.trim() !== expectedBranch) return null;
    const head = spawnSync("git", ["-C", root, "rev-parse", "--verify", "HEAD^{commit}"], {
      shell: false, encoding: "utf8", timeout: 10_000,
    });
    const sha = head.stdout.trim();
    return head.status === 0 && (/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(sha)) ? sha : null;
  } catch { return null; }
}

function reference(repository: EngineerCanonicalRepository): RepositoryReference {
  return {
    repositoryId: repository.repositoryId,
    provider: repository.provider,
    owner: repository.owner,
    name: repository.name,
    baseBranch: repository.baseBranch,
    baseCommitSha: repository.baseCommitSha,
    url: repository.originUrl,
  };
}

function sameRepositoryIdentity(left: RepositoryReference, right: RepositoryReference): boolean {
  return left.repositoryId === right.repositoryId && left.provider === right.provider &&
    left.owner === right.owner && left.name === right.name &&
    (right.url === undefined || left.url === right.url) && left.baseBranch === right.baseBranch;
}

function configuredIdentity(repository: RepositoryReference): Omit<RepositoryReference, "baseCommitSha"> {
  return {
    repositoryId: repository.repositoryId,
    provider: repository.provider,
    owner: repository.owner,
    name: repository.name,
    ...(repository.url ? { url: repository.url } : {}),
    baseBranch: repository.baseBranch,
  };
}

function isCommitAncestor(repositoryRoot: string, ancestor: string, descendant: string): boolean {
  const result = spawnSync("git", ["-C", repositoryRoot, "merge-base", "--is-ancestor", ancestor, descendant], {
    shell: false, encoding: "utf8", timeout: 10_000,
  });
  return result.status === 0;
}

/**
 * Durable, owner-scoped repository allow-list. Repository connection rows made
 * during run intake never become admissions; only this server-owned surface can
 * create the separate admission record.
 */
export class DurableEngineerRepositoryAdmissionRegistry implements EngineerRepositoryAdmissionRegistry {
  private readonly roots = new Map<string, string>();
  private readonly options: DurableEngineerRepositoryAdmissionRegistryOptions;
  private readonly primaryRepositoryId: string;

  constructor(options: DurableEngineerRepositoryAdmissionRegistryOptions) {
    this.options = options;
    const canonical = reference(options.canonical);
    this.primaryRepositoryId = canonical.repositoryId;
    const repositoryRoot = realpathSync(options.canonicalRepositoryRoot);
    this.roots.set(canonical.repositoryId, repositoryRoot);
    const admissionId = `configured:${sha256({ ownerUserId: options.ownerUserId, repositoryId: canonical.repositoryId })}`;
    const authorizationEvidenceHash = sha256({
      source: "gateway-environment",
      ownerUserId: options.ownerUserId,
      repository: configuredIdentity(canonical),
    });
    const existing = options.supervisor.repositoryAdmission(options.ownerUserId, canonical.repositoryId);
    // One-time compatibility migration from the earlier evidence format that
    // incorrectly included the mutable base commit. The durable record itself
    // is trusted only when every immutable configured identity field matches.
    if (existing?.status === "ACTIVE" && existing.source === "CONFIGURED_CANONICAL" &&
        existing.admissionId === admissionId && existing.authorizationSubject === "gateway-environment" &&
        sameRepositoryIdentity(existing.repository, canonical) &&
        existing.authorizationEvidenceHash.toLowerCase() !== authorizationEvidenceHash.toLowerCase()) {
      const exactLegacyEvidenceHash = sha256({ source: "gateway-environment", repository: existing.repository });
      if (existing.authorizationEvidenceHash.toLowerCase() !== exactLegacyEvidenceHash.toLowerCase()) {
        throw new Error("configured repository admission evidence does not match stable or exact legacy identity evidence");
      }
      options.supervisor.migrateLegacyConfiguredRepositoryAdmissionEvidence({
        ownerUserId: options.ownerUserId,
        repositoryId: canonical.repositoryId,
        nextEvidenceHash: authorizationEvidenceHash,
      });
    }
    const admitted = options.supervisor.registerRepositoryAdmission({
      admissionId,
      ownerUserId: options.ownerUserId,
      repository: canonical,
      source: "CONFIGURED_CANONICAL",
      authorizationSubject: "gateway-environment",
      authorizationEvidenceHash,
      existingBasePolicy: "PRESERVE_EXISTING",
    });
    const localHead = resolveLocalRepositoryHead(repositoryRoot, canonical.baseBranch);
    if (localHead && admitted.repository.baseCommitSha.toLowerCase() !== localHead.toLowerCase() &&
        canonical.baseCommitSha.toLowerCase() === localHead.toLowerCase()) {
      if (!isCommitAncestor(repositoryRoot, admitted.repository.baseCommitSha, localHead)) {
        throw new Error("configured repository HEAD would roll back or diverge from the durable admitted base");
      }
      options.supervisor.advanceRepositoryAdmissionBase({
        ownerUserId: options.ownerUserId,
        repositoryId: canonical.repositoryId,
        previousBaseCommitSha: admitted.repository.baseCommitSha,
        nextBaseCommitSha: localHead,
      });
    }
  }

  primary(): RepositoryReference {
    return this.requireById(this.primaryRepositoryId).repository;
  }

  list(): RepositoryReference[] {
    return this.options.supervisor.listRepositoryAdmissions(this.options.ownerUserId)
      .filter((item) => this.isUsable(item))
      .map((item) => item.repository);
  }

  require(repository: RepositoryReference): RepositoryReference {
    const admission = this.requireById(repository.repositoryId);
    if (!sameRepositoryIdentity(admission.repository, repository) ||
        admission.repository.baseCommitSha.toLowerCase() !== repository.baseCommitSha.toLowerCase()) {
      throw new Error("Engineer preflight failed: repository does not match an active trusted admission");
    }
    return admission.repository;
  }

  advanceBase(previousBaseCommitSha: string, repository: RepositoryReference): void {
    const admission = this.requireById(repository.repositoryId);
    if (!sameRepositoryIdentity(admission.repository, repository)) {
      throw new Error("Engineer preflight failed: stale-base recovery attempted to change admitted repository identity");
    }
    if (admission.repository.baseCommitSha.toLowerCase() === repository.baseCommitSha.toLowerCase()) return;
    this.options.supervisor.advanceRepositoryAdmissionBase({
      ownerUserId: this.options.ownerUserId,
      repositoryId: repository.repositoryId,
      previousBaseCommitSha,
      nextBaseCommitSha: repository.baseCommitSha,
    });
  }

  repositoryRoot(repositoryId: string): string {
    this.requireById(repositoryId);
    const root = this.roots.get(repositoryId);
    if (!root) throw new Error("admitted repository has no trusted local checkout");
    return root;
  }

  /**
   * No public HTTP route calls this. It becomes usable only after the relay can
   * pass a server-verifiable, owner-bound connector grant to the gateway.
   */
  registerConnectorAuthorized(grant: ConnectorRepositoryAuthorization): RepositoryAdmission {
    this.assertConnectorGrant(grant);
    const root = realpathSync(grant.repositoryRoot);
    const admission = this.options.supervisor.registerRepositoryAdmission({
      admissionId: `connector:${grant.grantId}`,
      ownerUserId: this.options.ownerUserId,
      repository: grant.repository,
      source: "CONNECTOR_AUTHORIZED",
      authorizationSubject: grant.connectorId,
      authorizationEvidenceHash: grant.evidenceHash,
      authorizationExpiresAt: grant.expiresAt,
      authorizationGeneration: grant.generation,
    });
    this.roots.set(grant.repository.repositoryId, root);
    return admission;
  }

  revokeConnector(repositoryId: string): RepositoryAdmission {
    const admission = this.options.supervisor.repositoryAdmission(this.options.ownerUserId, repositoryId);
    if (!admission || admission.source !== "CONNECTOR_AUTHORIZED") {
      throw new Error("connector repository admission not found");
    }
    const revoked = this.options.supervisor.revokeRepositoryAdmission(this.options.ownerUserId, repositoryId);
    this.roots.delete(repositoryId);
    return revoked;
  }

  reauthorizeConnectorAuthorized(grant: ConnectorRepositoryAuthorization): RepositoryAdmission {
    this.assertConnectorGrant(grant);
    const existing = this.options.supervisor.repositoryAdmission(this.options.ownerUserId, grant.repository.repositoryId);
    if (!existing || existing.source !== "CONNECTOR_AUTHORIZED" || !sameRepositoryIdentity(existing.repository, grant.repository) ||
        existing.repository.baseCommitSha.toLowerCase() !== grant.repository.baseCommitSha.toLowerCase()) {
      throw new Error("connector repository reauthorization does not match the durable admission identity");
    }
    const root = realpathSync(grant.repositoryRoot);
    const admission = this.options.supervisor.reauthorizeConnectorRepositoryAdmission({
      ownerUserId: this.options.ownerUserId,
      repositoryId: grant.repository.repositoryId,
      previousGeneration: existing.authorizationGeneration,
      nextGeneration: grant.generation,
      authorizationSubject: grant.connectorId,
      authorizationEvidenceHash: grant.evidenceHash,
      authorizationExpiresAt: grant.expiresAt,
    });
    this.roots.set(grant.repository.repositoryId, root);
    return admission;
  }

  private requireById(repositoryId: string): RepositoryAdmission {
    const admission = this.options.supervisor.repositoryAdmission(this.options.ownerUserId, repositoryId);
    if (!admission || !this.isUsable(admission)) {
      throw new Error("Engineer preflight failed: repository is not in the active trusted admission registry");
    }
    return admission;
  }

  private isUsable(admission: RepositoryAdmission): boolean {
    if (admission.status !== "ACTIVE" || !this.roots.has(admission.repository.repositoryId)) return false;
    if (admission.source !== "CONNECTOR_AUTHORIZED") return true;
    const expiresAt = admission.authorizationExpiresAt ? new Date(admission.authorizationExpiresAt).getTime() : Number.NaN;
    return Number.isFinite(expiresAt) && expiresAt > (this.options.now ?? (() => new Date()))().getTime();
  }

  private assertConnectorGrant(grant: ConnectorRepositoryAuthorization): void {
    if (!this.options.verifyConnectorAuthorization?.(grant)) {
      throw new Error("connector repository authorization is unavailable or invalid");
    }
    const expiresAt = new Date(grant.expiresAt).getTime();
    if (grant.ownerUserId !== this.options.ownerUserId || !Number.isInteger(grant.generation) || grant.generation < 1 ||
        !Number.isFinite(expiresAt) || expiresAt <= (this.options.now ?? (() => new Date()))().getTime() ||
        !/^sha256:[a-f0-9]{64}$/i.test(grant.evidenceHash)) {
      throw new Error("connector repository authorization is invalid or expired");
    }
  }
}

/** Backwards-compatible single-process registry used only by isolated tests. */
export class StaticEngineerRepositoryAdmissionRegistry implements EngineerRepositoryAdmissionRegistry {
  private repository: RepositoryReference;
  constructor(canonical: EngineerCanonicalRepository) { this.repository = reference(canonical); }
  primary(): RepositoryReference { return { ...this.repository }; }
  list(): RepositoryReference[] { return [this.primary()]; }
  require(repository: RepositoryReference): RepositoryReference {
    if (!sameRepositoryIdentity(this.repository, repository) || this.repository.baseCommitSha.toLowerCase() !== repository.baseCommitSha.toLowerCase()) {
      throw new Error("Engineer preflight failed: repository does not match an active trusted admission (canonical fixture)");
    }
    return this.primary();
  }
  advanceBase(previousBaseCommitSha: string, repository: RepositoryReference): void {
    if (!sameRepositoryIdentity(this.repository, repository) || this.repository.baseCommitSha.toLowerCase() !== previousBaseCommitSha.toLowerCase()) {
      throw new Error("Engineer preflight failed: stale-base recovery attempted to change canonical repository identity or canonical base advanced concurrently");
    }
    this.repository = { ...this.repository, baseCommitSha: repository.baseCommitSha };
  }
  repositoryRoot(): string { throw new Error("static test registry has no repository checkout"); }
}
