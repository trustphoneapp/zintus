import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import type { RepositoryReference, ResponsesTransport } from "@zintus/engineer";

export interface EngineerModelCapability {
  available: boolean;
  responsesApi: boolean;
  strictStructuredOutputs: boolean;
}

export interface EngineerCapabilityProbe {
  model(model: string): Promise<EngineerModelCapability>;
  docker(): Promise<{ available: boolean }>;
  image(imageReference: string, imageDigest: string): Promise<{ exactDigest: boolean }>;
  repository(repository: RepositoryReference): Promise<{ readable: boolean; exactBaseCommit: boolean }>;
  publication(repository: RepositoryReference): Promise<{ available: boolean; pullRequestsWritable: boolean }>;
}

export interface EngineerCanonicalRepository {
  repositoryId: string;
  provider: RepositoryReference["provider"];
  owner: string;
  name: string;
  baseBranch: string;
  baseCommitSha: string;
  originUrl: string;
}

export type EngineerReadiness =
  | { state: "DISABLED" | "NOT_STARTED" | "PENDING" | "READY"; error: null }
  | { state: "FAILED"; error: string };

export interface EngineerCapabilityPreflightOptions {
  models: readonly string[];
  execution?: { imageReference: string; imageDigest: string };
  publicationEnabled: boolean;
  repository: EngineerCanonicalRepository;
  probe: EngineerCapabilityProbe;
  unavailableReason?: string;
}

/** A cached, fail-closed admission gate. Failed checks are deliberately not cached. */
export class EngineerCapabilityPreflight {
  private startupPromise: Promise<void> | null = null;
  private readinessState: EngineerReadiness;
  private readonly options: EngineerCapabilityPreflightOptions;

  constructor(options: EngineerCapabilityPreflightOptions) {
    this.options = options;
    this.readinessState = options.unavailableReason
      ? { state: "DISABLED", error: null }
      : { state: "NOT_STARTED", error: null };
  }

  readiness(): EngineerReadiness { return { ...this.readinessState }; }

  assertStartup(): Promise<void> {
    if (!this.startupPromise) {
      this.readinessState = { state: "PENDING", error: null };
      this.startupPromise = this.runStartup()
        .then(() => { this.readinessState = { state: "READY", error: null }; })
        .catch((error) => {
          this.readinessState = { state: "FAILED", error: error instanceof Error ? error.message : String(error) };
          throw error;
        })
        .finally(() => { this.startupPromise = null; });
    }
    return this.startupPromise;
  }

  async assertRunAdmission(repository: RepositoryReference): Promise<void> {
    await this.assertStartup();
    const expected = this.options.repository;
    if (repository.repositoryId !== expected.repositoryId || repository.provider !== expected.provider ||
        repository.owner !== expected.owner || repository.name !== expected.name ||
        repository.baseBranch !== expected.baseBranch ||
        repository.baseCommitSha.toLowerCase() !== expected.baseCommitSha.toLowerCase()) {
      throw new Error("Engineer preflight failed: repository does not match the frozen canonical fixture");
    }
  }

  private async runStartup(): Promise<void> {
    if (this.options.unavailableReason) throw new Error(`Engineer preflight failed: ${this.options.unavailableReason}`);
    const canonical = this.options.repository;
    if (!canonical.repositoryId.trim() || !canonical.owner.trim() || !canonical.name.trim() || !canonical.baseBranch.trim() || !canonical.originUrl.trim() ||
        !/^[a-f0-9]{40}$|^[a-f0-9]{64}$/i.test(canonical.baseCommitSha)) {
      throw new Error("Engineer preflight failed: canonical repository identity and exact base SHA are invalid");
    }
    const models = [...new Set(this.options.models)];
    if (models.length === 0 || models.some((model) => !model.trim())) {
      throw new Error("Engineer preflight failed: exact model identifiers are required");
    }
    for (const model of models) {
      const capability = await this.options.probe.model(model);
      if (!capability.available || !capability.responsesApi || !capability.strictStructuredOutputs) {
        throw new Error(`Engineer preflight failed: ${model} lacks required Responses/structured-output capabilities`);
      }
    }
    if (this.options.execution) {
      if (!/^sha256:[a-f0-9]{64}$/i.test(this.options.execution.imageDigest)) {
        throw new Error("Engineer preflight failed: execution image digest must be immutable sha256");
      }
      if (!this.options.execution.imageReference.endsWith(`@${this.options.execution.imageDigest}`)) {
        throw new Error("Engineer preflight failed: image reference must be the canonical repository@sha256 digest");
      }
      if (!(await this.options.probe.docker()).available) {
        throw new Error("Engineer preflight failed: Docker runtime is unavailable");
      }
      const image = await this.options.probe.image(
        this.options.execution.imageReference,
        this.options.execution.imageDigest,
      );
      if (!image.exactDigest) throw new Error("Engineer preflight failed: configured image digest is unavailable");
    }
    const trustedRepository: RepositoryReference = {
      repositoryId: canonical.repositoryId,
      provider: canonical.provider,
      owner: canonical.owner,
      name: canonical.name,
      baseBranch: canonical.baseBranch,
      baseCommitSha: canonical.baseCommitSha,
      url: canonical.originUrl,
    };
    const access = await this.options.probe.repository(trustedRepository);
    if (!access.readable || !access.exactBaseCommit) {
      throw new Error("Engineer preflight failed: canonical repository, origin, branch, or exact base commit is unavailable");
    }
    if (this.options.publicationEnabled) {
      const publication = await this.options.probe.publication(trustedRepository);
      if (!publication.available || !publication.pullRequestsWritable) {
        throw new Error("Engineer preflight failed: pull-request publication capability is unavailable");
      }
    }
  }
}

export function createLocalEngineerCapabilityProbe(options: {
  transport: () => Promise<ResponsesTransport>;
  repositoryId: string;
  repositoryRoot: string;
  expectedOriginUrl: string;
  githubToken?: string;
}): EngineerCapabilityProbe {
  const normalizeOrigin = (value: string): string => {
    const trimmed = value.trim().replace(/\.git$/i, "").replace(/\/$/, "");
    const ssh = /^git@([^:]+):(.+)$/i.exec(trimmed);
    if (ssh) return `${ssh[1]!.toLowerCase()}/${ssh[2]!.toLowerCase()}`;
    try {
      const url = new URL(trimmed);
      return `${url.hostname.toLowerCase()}${url.pathname.toLowerCase()}`;
    } catch { return trimmed; }
  };
  const git = (args: string[]) => spawnSync("git", ["-C", realpathSync(options.repositoryRoot), ...args], {
    shell: false, encoding: "utf8", timeout: 30_000,
  });
  return {
    async model(model) {
      try {
        const response = await (await options.transport()).create({
          model,
          input: [{ role: "user", content: [{ type: "input_text", text: "Call capability_ready with ready=true." }] }],
          tools: [{
            type: "function", name: "capability_ready", description: "Confirm required model capabilities.", strict: true,
            parameters: { type: "object", additionalProperties: false, required: ["ready"], properties: { ready: { type: "boolean" } } },
          }],
          tool_choice: { type: "function", name: "capability_ready" }, parallel_tool_calls: false,
          max_output_tokens: 32, store: false,
        });
        const responseRecord = response as unknown as Record<string, unknown>;
        if (typeof responseRecord.model === "string" && responseRecord.model !== model) {
          return { available: false, responsesApi: true, strictStructuredOutputs: false };
        }
        const calls = response.output.filter((item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "function_call") as Array<Record<string, unknown>>;
        let ready = calls.length === 1 && calls[0]?.name === "capability_ready" && typeof calls[0]?.arguments === "string";
        if (ready) {
          try {
            const args = JSON.parse(calls[0]!.arguments as string) as unknown;
            ready = Boolean(args && typeof args === "object" && !Array.isArray(args) &&
              Object.keys(args as Record<string, unknown>).join(",") === "ready" &&
              (args as { ready?: unknown }).ready === true);
          } catch { ready = false; }
        }
        return { available: ready, responsesApi: ready, strictStructuredOutputs: ready };
      } catch {
        return { available: false, responsesApi: false, strictStructuredOutputs: false };
      }
    },
    async docker() {
      const result = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
        shell: false, encoding: "utf8", timeout: 30_000,
      });
      return { available: result.status === 0 && Boolean(result.stdout.trim()) };
    },
    async image(imageReference, imageDigest) {
      const withoutDigest = imageReference.replace(/@sha256:[a-f0-9]{64}$/i, "");
      const lastSlash = withoutDigest.lastIndexOf("/");
      const lastColon = withoutDigest.lastIndexOf(":");
      const repositoryName = lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
      const canonicalReference = `${repositoryName}@${imageDigest}`;
      const result = spawnSync("docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", canonicalReference], {
        shell: false, encoding: "utf8", timeout: 30_000,
      });
      if (result.status !== 0) return { exactDigest: false };
      try {
        const digests = JSON.parse(result.stdout.trim()) as unknown;
        return { exactDigest: Array.isArray(digests) && digests.includes(canonicalReference) };
      } catch { return { exactDigest: false }; }
    },
    async repository(repository) {
      if (repository.repositoryId !== options.repositoryId) return { readable: false, exactBaseCommit: false };
      const resolved = git(["rev-parse", "--verify", `${repository.baseCommitSha}^{commit}`]);
      const baseRef = git(["rev-parse", "--verify", `${repository.baseBranch}^{commit}`]);
      const origin = git(["remote", "get-url", "origin"]);
      return {
        readable: resolved.status === 0 && origin.status === 0 && normalizeOrigin(origin.stdout) === normalizeOrigin(options.expectedOriginUrl),
        exactBaseCommit: resolved.status === 0 && baseRef.status === 0 &&
          resolved.stdout.trim().toLowerCase() === repository.baseCommitSha.toLowerCase() &&
          baseRef.stdout.trim().toLowerCase() === repository.baseCommitSha.toLowerCase(),
      };
    },
    async publication(repository) {
      if (!options.githubToken || repository.provider !== "github") return { available: false, pullRequestsWritable: false };
      try {
        const api = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
        const response = await fetch(api, {
          headers: {
            Authorization: `Bearer ${options.githubToken}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) return { available: false, pullRequestsWritable: false };
        // A deliberately nonexistent head cannot create a PR. GitHub returns
        // 422 only after authorization succeeds; a token without PR write gets 403.
        const canary = await fetch(`${api}/pulls`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.githubToken}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({
            title: "Zintus Engineer permission probe",
            head: "zintus-engineer-capability-probe-does-not-exist",
            base: repository.baseBranch,
          }),
          signal: AbortSignal.timeout(15_000),
        });
        return { available: true, pullRequestsWritable: canary.status === 422 };
      } catch { return { available: false, pullRequestsWritable: false }; }
    },
  };
}
