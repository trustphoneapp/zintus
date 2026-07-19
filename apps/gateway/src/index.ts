export { startCloudConnection, type CloudOptions, type CloudConnection } from "./cloud.js";
export {
  getOrCreateGatewayKeypair,
  decryptKeyPayload,
  type GatewayKeypair,
} from "./crypto.js";
export { detectLocalRuntimes, type LocalRuntimes } from "./local-runtimes.js";
export {
  computeRouteOptions,
  LOW_QUOTA_THRESHOLD,
  type RouteOption,
  type RouteOptionsInputs,
  type RouteOptionsResult,
} from "./route-options.js";
export { MCPRegistry, type MCPRegistryOptions } from "./mcp-registry.js";
export { EngineerRunManager, type EngineerRunManagerOptions } from "./engineer.js";
export { deriveEngineerPrincipal, loadOrCreateEngineerPrincipal, loadOrCreateEngineerWorkerLeaseSecret, type EngineerPrincipal } from "./engineer-identity.js";
export { EngineerCapabilityPreflight, type EngineerCapabilityProbe } from "./engineer-preflight.js";
export { DurableEngineerRepositoryAdmissionRegistry } from "./engineer-repository-registry.js";
// Re-exported so integration tests (and @zintus/test-utils) can build a handler
// against a custom engine without reaching into ./handler.js internals.
export {
  createGatewayHandler,
  type GatewayHandlerDeps,
  type ErrorHook,
  type LogFn as GatewayLogFn,
} from "./handler.js";
import { createEngine } from "@zintus/engine";
import { loadPolicy, watchPolicy, redactSecrets } from "@zintus/router";
import { DEFAULT_CONFIG } from "@zintus/types";
import { ActivityStore } from "./activity-store.js";
import { buildGatewayConfig, type GatewayConfig } from "./auth.js";
import { applyGatewayDotenv } from "./dotenv.js";
import { createGatewayHandler, type LogFn } from "./handler.js";
import { detectLocalRuntimes } from "./local-runtimes.js";
import { createErrorSink } from "./observability.js";
import { createRateLimiter, type RateLimiter } from "./rate-limit.js";
import { MCPRegistry } from "./mcp-registry.js";
import { getKey as getProviderKey } from "@zintus/keychain";
import {
  DockerSandboxManager,
  BudgetPausedError,
  ContextEngine,
  EngineerContextManager,
  EngineerExecutionManager,
  EngineerWorkerLeaseManager,
  EngineerPlanningManager,
  EngineerVerificationManager,
  EngineerSupervisor,
  GitWorkspaceManager,
  GitHubGitService,
  GitPublicationMechanics,
  gitCommitLockfileHash,
  OpenAIResponsesTransport,
  OfflineDependencyBundle,
  NO_LOCKFILE_HASH,
  resolveEngineerModel,
  ResolutionDesk,
  ResolutionReplacementRunFactory,
  deriveCaseCreationInput,
  serverPricingPolicyDigest,
  WarmSandboxPool,
  type PublicationAuthorityService,
} from "@zintus/engineer";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { EngineerRunManager } from "./engineer.js";
import { createBoundEngineerArtifactStore } from "./engineer-artifact-store.js";
import { createLocalEngineerCapabilityProbe, EngineerCapabilityPreflight } from "./engineer-preflight.js";
import { DurableEngineerRepositoryAdmissionRegistry, resolveLocalRepositoryHead } from "./engineer-repository-registry.js";
import { canEnableEngineerPublication, loadOrCreateEngineerPrincipal, loadOrCreateEngineerWorkerLeaseSecret } from "./engineer-identity.js";
import { recoverHardeningPaidCallsOnce, recoverOptionalHardeningAfterPaidReconciliation,
  type HardeningPaidCallRecoverySweepResult } from "./hardening-recovery.js";
import { loadEngineerPromptCacheAuthority } from "./engineer-prompt-cache-authority.js";
import { loadEngineerResolutionSigningAuthority } from "./engineer-resolution-authority.js";
import type { EngineerResolutionDeskFacade, EngineerPublicationAuthorityFacade } from "./handler.js";
import { createEngineerPublicationAuthorityFacade } from "./engineer-publication-facade.js";

export interface StartGatewayOptions {
  /** Override GATEWAY_HOST (e.g. from a CLI flag). */
  host?: string;
  /** Override GATEWAY_PORT (e.g. from a CLI flag). */
  port?: number;
  /** Fetches a current connector credential without persisting it locally. */
  githubTokenProvider?: (options?: { forceRefresh?: boolean }) => Promise<string | undefined>;
  /** Result of an authenticated connector readiness probe performed before startup. */
  githubCredentialAvailable?: boolean;
}

export interface RunningGateway {
  server: ReturnType<typeof Bun.serve>;
  config: GatewayConfig;
  url: string;
  /**
   * Begin graceful shutdown: flip /health to draining (503), stop accepting new
   * connections, let in-flight streams finish, and clear background timers.
   * Idempotent. `extraCleanup` runs first (e.g. closing the cloud relay WS).
   */
  shutdown(extraCleanup?: () => void | Promise<void>): Promise<void>;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;
// Bun's default is 10 seconds, which is shorter than the Engineer's bounded
// 120-second Responses API calls. Keep the connection alive long enough for
// synchronous plan/freeze requests while application-level timeouts retain
// authority over model execution. Bun currently caps this value at 255 seconds.
export const GATEWAY_HTTP_IDLE_TIMEOUT_SECONDS = 255;

/**
 * Boot the gateway HTTP server and return a handle. Overrides are applied via
 * the environment first so all of buildGatewayConfig's validation still runs
 * (notably: refusing a public bind without GATEWAY_TOKEN). Used by both the
 * standalone entry below and the `zintus serve` CLI command.
 */
export function startGateway(options: StartGatewayOptions = {}): RunningGateway {
  if (options.host) {
    process.env.GATEWAY_HOST = options.host;
  }
  if (options.port != null) {
    process.env.GATEWAY_PORT = String(options.port);
  }

  // Fill env gaps from apps/gateway/.env — Bun only auto-loads .env from the
  // cwd, so starts from the repo root never saw it. Real env vars still win.
  applyGatewayDotenv();

  const config = buildGatewayConfig(process.env);

  // Declarative routing policy (policy.json) is loaded at startup and
  // hot-reloaded on change — no restart needed to retune weights, model
  // groups, or limits.
  const policy = loadPolicy();

  const engine = createEngine({
    strategy: DEFAULT_CONFIG.routingStrategy,
    providerPriority: DEFAULT_CONFIG.providerPriority,
    policy,
    // Keyless local runtimes (ollama/lmstudio) are only routing-eligible while
    // actually detected — reuses the 30s-cached /status probe, so a not-running
    // runtime is skipped at candidate selection instead of connection-refused.
    localRuntimeAlive: async (id) => (await detectLocalRuntimes())[id].detected,
  });

  // Durable, machine-local usage history (~/.zintus/activity.db, beside the
  // quota ledger) so GET /v1/activity is a real persistent 30-day feed. Opened
  // once and pruned on open; local-only, never sent anywhere.
  const activityStore = new ActivityStore();

  // MCP connection registry — the gateway HOSTS the MCP clients (server-side;
  // the browser can't spawn stdio). Connections are reused across requests and
  // drained on shutdown. Local-first / no-custody: MCP traffic never touches the
  // relay.
  const mcpRegistry = new MCPRegistry();

  // Zintus Engineer is always available for durable intake/plan records. The
  // execution worker is enabled only when an initial canonical repository and
  // immutable Docker image are explicitly configured. Additional repositories
  // require a server-verified connector admission and trusted local checkout.
  const engineerRoot = join(homedir(), ".zintus", "engineer");
  const engineerDbPath=join(engineerRoot,"engineer.db");
  const hardeningPromptCacheAuthority=loadEngineerPromptCacheAuthority({
    secretPath:join(engineerRoot,"prompt-cache.secret"),dbPath:engineerDbPath,
  });
  const hardeningPromptCacheSecret=hardeningPromptCacheAuthority.status==="READY"?
    hardeningPromptCacheAuthority.secret:undefined;
  const hardeningPromptCacheReadiness=hardeningPromptCacheAuthority.status==="READY"?
    {state:"READY" as const,code:null,message:null}:
    {state:"DEGRADED" as const,code:hardeningPromptCacheAuthority.status,
      message:"Optional hardening is temporarily unavailable. Restore the local prompt-cache authority, run bun run doctor:engineer, then restart the gateway. Existing runs and history remain available."};
  const engineerSupervisor = new EngineerSupervisor({ dbPath: engineerDbPath, hardeningPromptCacheSecret });
  const engineerRepositoryRoot = process.env.ZINTUS_ENGINEER_REPOSITORY_ROOT;
  const engineerRepositoryId = process.env.ZINTUS_ENGINEER_REPOSITORY_ID;
  const engineerImage = process.env.ZINTUS_ENGINEER_IMAGE;
  const engineerImageDigest = process.env.ZINTUS_ENGINEER_IMAGE_DIGEST;
  const engineerRepositoryProvider = process.env.ZINTUS_ENGINEER_REPOSITORY_PROVIDER;
  const engineerRepositoryOwner = process.env.ZINTUS_ENGINEER_REPOSITORY_OWNER;
  const engineerRepositoryName = process.env.ZINTUS_ENGINEER_REPOSITORY_NAME;
  const engineerBaseBranch = process.env.ZINTUS_ENGINEER_BASE_BRANCH;
  const engineerBaseCommitSha = process.env.ZINTUS_ENGINEER_BASE_COMMIT_SHA ??
    (engineerRepositoryProvider === "local" && engineerRepositoryRoot && engineerBaseBranch
      ? resolveLocalRepositoryHead(engineerRepositoryRoot, engineerBaseBranch) ?? undefined
      : undefined);
  const engineerOriginUrl = process.env.ZINTUS_ENGINEER_REPOSITORY_ORIGIN_URL;
  const engineerDependencyBundleRoot = process.env.ZINTUS_ENGINEER_DEPENDENCY_BUNDLE_ROOT;
  const engineerToolchainHash = process.env.ZINTUS_ENGINEER_TOOLCHAIN_HASH;
  let engineerRepositoryLockfileHash: string = NO_LOCKFILE_HASH;
  let engineerDependencyLockfileError: string | null = null;
  if (engineerRepositoryRoot && engineerBaseCommitSha) {
    try {
      engineerRepositoryLockfileHash = gitCommitLockfileHash(engineerRepositoryRoot, engineerBaseCommitSha);
    } catch (error) {
      engineerDependencyLockfileError = error instanceof Error ? error.message : String(error);
    }
  }
  const engineerDependenciesReady = !engineerDependencyLockfileError && (
    engineerRepositoryLockfileHash === NO_LOCKFILE_HASH ||
    Boolean(engineerDependencyBundleRoot && engineerToolchainHash)
  );
  const engineerArtifactStore = createBoundEngineerArtifactStore(
    engineerSupervisor,
    join(engineerRoot, "artifacts"),
  );
  // B4: the P8 two-person approver identity is derived from a SEPARATELY provisioned
  // credential. An operator provisions a second party by pointing
  // ENGINEER_APPROVER_IDENTITY_PATH at a distinct owner-only identity file; absent it,
  // `approverId` is null and the P8 approve path fails closed (a single install cannot
  // self-approve).
  const engineerApproverIdentityPath = process.env.ENGINEER_APPROVER_IDENTITY_PATH?.trim() || undefined;
  const engineerPrincipal = loadOrCreateEngineerPrincipal(join(engineerRoot, "identity.json"), engineerApproverIdentityPath);
  const transportForRole = async () => {
    const apiKey = await getProviderKey("openai");
    if (!apiKey) throw new Error("OpenAI BYOK key is required for Zintus Engineer");
    return new OpenAIResponsesTransport({ apiKey });
  };
  const engineerModelConfiguration = {
    sol: process.env.ZINTUS_ENGINEER_MODEL_SOL,
    terra: process.env.ZINTUS_ENGINEER_MODEL_TERRA,
    luna: process.env.ZINTUS_ENGINEER_MODEL_LUNA,
  };
  const publicationSecret = process.env.ZINTUS_ENGINEER_PUBLICATION_SECRET;
  const githubToken = process.env.ZINTUS_ENGINEER_GITHUB_TOKEN;
  // Publication is a privileged mutation boundary. Credentials alone are not
  // sufficient: the gateway itself must require an authenticated bearer.
  const publicationAuthorityReady = canEnableEngineerPublication({
    publicationSecret,
    githubToken,
    githubCredentialProvider: Boolean(options.githubTokenProvider && options.githubCredentialAvailable),
    gatewayToken: config.token,
  });
  const currentGithubToken = async (forceRefresh = false): Promise<string> => {
    const token = await options.githubTokenProvider?.({ forceRefresh }) ?? process.env.ZINTUS_ENGINEER_GITHUB_TOKEN;
    if (!token?.trim()) throw new Error("GitHub publication credential is unavailable or expired; reconnect GitHub");
    return token;
  };
  const engineerPlanning = new EngineerPlanningManager({
    supervisor: engineerSupervisor,
    artifactStore: engineerArtifactStore,
    transportForRun: transportForRole,
    modelConfiguration: engineerModelConfiguration,
    safetyIdentifierForUser: (userId) => {
      if (userId !== engineerPrincipal.ownerId) throw new Error("unknown Engineer safety subject");
      return engineerPrincipal.safetyIdentifier;
    },
    sessionIdentifierForUser: (userId) => {
      if (userId !== engineerPrincipal.ownerId) throw new Error("unknown Engineer session subject");
      return engineerPrincipal.sessionId;
    },
  });
  let engineerExecution: EngineerExecutionManager | undefined;
  let engineerWorkerLeases: EngineerWorkerLeaseManager | undefined;
  let engineerVerification: EngineerVerificationManager | undefined;
  let engineerPublicationAuthorityService: PublicationAuthorityService | undefined;
  let engineerWarmPool: WarmSandboxPool | undefined;
  let engineerSandboxManager: DockerSandboxManager | undefined;
  let engineerPrewarmConfig: { repositoryId: string; repositoryRoot: string; getBaseCommitSha: () => string } | undefined;
  let recoverHardeningPaidCalls: (() => HardeningPaidCallRecoverySweepResult) | undefined;
  const unavailablePreflight = new EngineerCapabilityPreflight({
    models: [], publicationEnabled: false,
    repository: { repositoryId: "unconfigured", provider: "local", owner: "unconfigured", name: "unconfigured", baseBranch: "unconfigured", baseCommitSha: "0".repeat(40), originUrl: "unconfigured" },
    probe: {
      model: async () => ({ available: false, responsesApi: false, strictStructuredOutputs: false }),
      docker: async () => ({ available: false }), image: async () => ({ exactDigest: false }),
      repository: async () => ({ readable: false, exactBaseCommit: false }),
      publication: async () => ({ available: false, pullRequestsWritable: false }),
    },
    unavailableReason: "canonical repository, exact base, model, Docker, and image configuration is incomplete",
  });
  let engineerRuns = new EngineerRunManager({ supervisor: engineerSupervisor, planning: engineerPlanning, artifactStore: engineerArtifactStore, principal: engineerPrincipal, preflight: unavailablePreflight });
  if (engineerRepositoryRoot && engineerRepositoryId && engineerImage && engineerImageDigest && engineerDependenciesReady &&
      (engineerRepositoryProvider === "local" || engineerRepositoryProvider === "github") &&
      engineerRepositoryOwner && engineerRepositoryName && engineerBaseBranch && engineerBaseCommitSha && engineerOriginUrl) {
    const engineerRepositoryRegistry = new DurableEngineerRepositoryAdmissionRegistry({
      supervisor: engineerSupervisor,
      ownerUserId: engineerPrincipal.ownerId,
      canonical: {
        repositoryId: engineerRepositoryId, provider: engineerRepositoryProvider,
        owner: engineerRepositoryOwner, name: engineerRepositoryName,
        baseBranch: engineerBaseBranch, baseCommitSha: engineerBaseCommitSha, originUrl: engineerOriginUrl,
      },
      canonicalRepositoryRoot: engineerRepositoryRoot,
    });
    const engineerPreflight = new EngineerCapabilityPreflight({
      models: [
        resolveEngineerModel("BUILDER", engineerModelConfiguration).model,
        resolveEngineerModel("PLANNER", engineerModelConfiguration).model,
        resolveEngineerModel("REQUEST_CLASSIFIER", engineerModelConfiguration).model,
      ],
      execution: { imageReference: engineerImage, imageDigest: engineerImageDigest },
      publicationEnabled: publicationAuthorityReady,
      repository: {
        repositoryId: engineerRepositoryId, provider: engineerRepositoryProvider,
        owner: engineerRepositoryOwner, name: engineerRepositoryName,
        baseBranch: engineerBaseBranch, baseCommitSha: engineerBaseCommitSha, originUrl: engineerOriginUrl,
      },
      admissionRegistry: engineerRepositoryRegistry,
      probe: createLocalEngineerCapabilityProbe({
        transport: transportForRole,
        repositoryId: engineerRepositoryId,
        repositoryRoot: engineerRepositoryRoot,
        expectedOriginUrl: engineerOriginUrl,
        repositoryRootFor: (repositoryId) => engineerRepositoryRegistry.repositoryRoot(repositoryId),
        ...(githubToken || (options.githubTokenProvider && options.githubCredentialAvailable)
          ? { githubToken: () => currentGithubToken(false) }
          : {}),
      }),
    });
    // Warm the cached gate at process startup. Admission retries a failed probe
    // and remains fail-closed, so this never creates a run on partial readiness.
    void engineerPreflight.assertStartup().catch((error) => {
      process.stderr.write(`[zintus] Engineer startup preflight failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}\n`);
    });
    const workspaceManager = new GitWorkspaceManager({ workspaceRoot: join(engineerRoot, "workspaces") });
    const engineerContext = new EngineerContextManager({
      supervisor: engineerSupervisor,
      contextEngine: new ContextEngine({}),
      artifactStore: engineerArtifactStore,
      repositoryRootFor: (repositoryId) => {
        return engineerRepositoryRegistry.repositoryRoot(repositoryId);
      },
    });
    const warmLockfileHash = process.env.ZINTUS_ENGINEER_LOCKFILE_HASH;
    const warmToolchainHash = process.env.ZINTUS_ENGINEER_TOOLCHAIN_HASH;
    const offlineDependencies = engineerDependencyBundleRoot && engineerToolchainHash
      ? new OfflineDependencyBundle({
          root: engineerDependencyBundleRoot,
          expectedLockfileHash: engineerRepositoryLockfileHash,
          expectedToolchainHash: engineerToolchainHash,
          expectedRepositoryCommit: engineerBaseCommitSha,
        })
      : undefined;
    engineerWarmPool = warmLockfileHash && warmToolchainHash
      ? new WarmSandboxPool({ root: join(engineerRoot, "warm-pool") })
      : undefined;
    const warmPool = warmLockfileHash && warmToolchainHash && engineerWarmPool
      ? {
          pool: engineerWarmPool,
          lockfileHash: warmLockfileHash,
          toolchainHash: warmToolchainHash,
        }
      : undefined;
    const sandboxManager = new DockerSandboxManager({
      workspaceManager,
      imageReference: engineerImage,
      imageDigest: engineerImageDigest,
      ...(warmPool ? { warmPool } : {}),
      ...(offlineDependencies ? { offlineDependencies } : {}),
    });
    engineerSandboxManager = sandboxManager;
    const prewarmBaseCommit = process.env.ZINTUS_ENGINEER_PREWARM_BASE_COMMIT_SHA;
    if (prewarmBaseCommit && warmPool) {
      engineerPrewarmConfig = {
        repositoryId: engineerRepositoryId,
        repositoryRoot: engineerRepositoryRoot,
        getBaseCommitSha: () => engineerPreflight.repository().baseCommitSha,
      };
      sandboxManager.prewarm({
        repositoryId: engineerRepositoryId,
        repositoryRoot: engineerRepositoryRoot,
        baseCommitSha: prewarmBaseCommit,
      });
    }
    const configuredWorkerConcurrency = Number(process.env.ZINTUS_ENGINEER_WORKER_CONCURRENCY ?? "2");
    const workerConcurrency = Number.isInteger(configuredWorkerConcurrency) && configuredWorkerConcurrency > 0
      ? configuredWorkerConcurrency : 2;
    const workerLeaseSecret = loadOrCreateEngineerWorkerLeaseSecret(join(engineerRoot, "worker-lease.secret"));
    const checkpointSecret = loadOrCreateEngineerWorkerLeaseSecret(join(engineerRoot, "verified-candidate.secret"));
    const checkpointKeyId = `local-checkpoint-${createHash("sha256").update(checkpointSecret).digest("hex").slice(0, 24)}`;
    const checkpointAttestor = {
      algorithm: "hmac-sha256",
      keyId: checkpointKeyId,
      sign: (payload: Uint8Array) => `hmac-sha256:${createHmac("sha256", checkpointSecret).update(payload).digest("hex")}`,
      verify: (payload: Uint8Array, signature: string) => {
        const expected = `hmac-sha256:${createHmac("sha256", checkpointSecret).update(payload).digest("hex")}`;
        return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
      },
    };
    engineerSupervisor.configureCheckpointAttestor(checkpointAttestor);
    engineerWorkerLeases = new EngineerWorkerLeaseManager({
      dbPath: join(engineerRoot, "worker-leases.db"),
      tokenSecret: workerLeaseSecret,
      maxConcurrentLeases: workerConcurrency,
      watchdogIntervalMs: 10_000,
      recoverExpiredLease: async (lease) => {
        const runId = lease.resourceKey.startsWith("run:") ? lease.resourceKey.slice(4) : "";
        if (!runId) return;
        const run = engineerSupervisor.getRun(runId);
        if (run.terminalAt) return;
        // Optional hardening is a paid lane whose durable cache identity is
        // part of the reservation authority. Never mutate or resume that lane
        // while the local authority is degraded; ordinary Engineer recovery
        // remains available.
        if (engineerSupervisor.isOptionalHardeningChild(runId)) {
          if (hardeningPromptCacheReadiness.state !== "READY") return;
          // Paid-call reconciliation owns every outstanding reservation,
          // finalization, and pre-reservation crash boundary. The generic
          // watchdog must not finalize that generation or spend its retries.
          if (engineerSupervisor.hasOutstandingHardeningPaidCallRecoveryWork(runId)) return;
          if(run.state!=="CANCELLATION_PENDING"){
            for(const recovery of recoverOptionalHardeningAfterPaidReconciliation({runIds:[runId],
              supervisor:engineerSupervisor,runs:engineerRuns,execution:engineerExecution}))
              recovery.promise.catch(()=>undefined);
            return;
          }
        }
        if (run.state === "CANCELLATION_PENDING") {
          engineerRuns.resumeCancellation(runId);
          return;
        }
        if (run.state === "PLANNING" || run.state === "REPLANNING") {
          engineerRuns.resumePlanning(runId);
          return;
        }
        if (run.state === "QUEUED") {
          engineerExecution?.resumeRecovered(runId);
          return;
        }
        const outcome = await engineerExecution?.recoverInterrupted(runId, lease.leaseId);
        if (outcome === "REQUEUED") engineerExecution?.resumeRecovered(runId);
        else if (outcome === "IGNORED") engineerVerification?.resumeRecovered(runId);
      },
    });
    engineerSupervisor.configureRecoveryWorkerLeaseAuthority(engineerWorkerLeases);
    engineerExecution = new EngineerExecutionManager({
      supervisor: engineerSupervisor,
      sandboxManager,
      artifactStore: engineerArtifactStore,
      repositoryRootFor: (repositoryId) => {
        return engineerRepositoryRegistry.repositoryRoot(repositoryId);
      },
      transportForRun: transportForRole,
      leaseManager: engineerWorkerLeases,
      workerOwnerId: `gateway:${process.pid}`,
      hardeningPromptCacheSecret,
      builderOptions: {
        modelConfiguration: engineerModelConfiguration,
      },
      safetyIdentifierForUser: (userId) => {
        if (userId !== engineerPrincipal.ownerId) throw new Error("unknown Engineer safety subject");
        return engineerPrincipal.safetyIdentifier;
      },
    });
    engineerVerification = new EngineerVerificationManager({
      supervisor: engineerSupervisor,
      executionManager: engineerExecution,
      sandboxManager,
      artifactStore: engineerArtifactStore,
      transportForRole: async () => transportForRole(),
      transportForFailureClassifier: async () => transportForRole(),
      modelConfiguration: engineerModelConfiguration,
      leaseManager: engineerWorkerLeases,
      workerOwnerId: `gateway:${process.pid}:verification`,
      hardeningPromptCacheSecret,
      checkpointAttestor,
      safetyIdentifierForUser: (userId) => {
        if (userId !== engineerPrincipal.ownerId) throw new Error("unknown Engineer safety subject");
        return engineerPrincipal.safetyIdentifier;
      },
    });
    // One credentialed git service for the P8 dispatch actuator (the real
    // credentialed branch/PR effect). The legacy EngineerPublicationManager has
    // been RETIRED from the new-run authority path (R5A): P8
    // (PublicationAuthorityService) is the SOLE authoritative publication system
    // for new runs. Its Git mechanics already live in GitPublicationMechanics
    // (R5B). The legacy class is no longer constructed here and no longer wired
    // into EngineerRunManager, so a new run is never advanced into the legacy
    // HUMAN_APPROVAL_PENDING lane — it terminates at REVIEW_APPROVED and P8 owns
    // approval + publication (candidate → approval → publication → dispatch).
    // Historical runs that already went through the legacy lane still read back
    // their approval/evidence/publication history: every EngineerRunManager read
    // path (approvalView / evidenceBundles / gitOperations / artifacts / claims)
    // goes through the supervisor ledger, never through the retired manager.
    const engineerGitService = new GitHubGitService({
      repositoryRoot: engineerRepositoryRoot,
      token: () => currentGithubToken(false),
      refreshToken: () => currentGithubToken(true),
    });
    engineerRuns = new EngineerRunManager({
      supervisor: engineerSupervisor,
      execution: engineerExecution,
      verification: engineerVerification,
      planning: engineerPlanning,
      context: engineerContext,
      artifactStore: engineerArtifactStore,
      preflight: engineerPreflight,
      principal: engineerPrincipal,
      checkpointAttestor,
      hardeningPromptCacheReadiness,
      leaseManager: engineerWorkerLeases,
      workerOwnerId: `gateway:${process.pid}:planning`,
      cleanupRun: (runId) => { engineerExecution?.destroy(runId); },
      // NB: no `publication:` — the legacy publication authority is retired from
      // the new-run path (R5A). P8 governs publication for new runs.
      diffForRun: (runId) => {
        const sandbox = engineerExecution?.getSandbox(runId);
        if (!sandbox) {
          const artifact = engineerSupervisor.listArtifacts(runId).filter((item) => item.type === "FINAL_DIFF" && item.trusted).at(-1);
          if (!artifact) throw new Error("Engineer reviewed diff is unavailable");
          return (engineerSupervisor.isOptionalHardeningChild(runId)
            ?engineerArtifactStore.readVerifiedExact(artifact):engineerArtifactStore.read(artifact)).toString("utf8");
        }
        return workspaceManager.diff(sandbox.workspace);
      },
    });
    // P8 publication-authority service, constructed on the ledger's live
    // connection with the REAL replacement-lineage verifier (bound inside
    // createPublicationAuthorityService). The credentialed effect seams
    // (preflight / credentialProvider / actuator) are supplied here by the
    // AUTHORITY-FREE GitPublicationMechanics (packages/engineer): P8 owns the
    // approval/state/attestation authority and drives these pure Git mechanics
    // for the effect — REAL protected-base preflight, base-SHA recheck, rich PR
    // body, deterministic branch/push/PR, existing-PR discovery, and remote
    // reconciliation. It NEVER invokes the legacy EngineerPublicationManager.
    // DISPATCH is committed durably before the remote call, so a crash never
    // re-issues it (boot recovery parks RECONCILING). The [HUMAN] credential
    // boundary is enforced in the facade: when no GitHub token is configured,
    // dispatch is withheld with a 503 and the publication stays PREFLIGHT
    // (re-driveable once GitHub is connected).
    if (publicationAuthorityReady) {
      const publicationDiffForRun = (runId: string): string => {
        const sandbox = engineerExecution?.getSandbox(runId);
        if (!sandbox) {
          const artifact = engineerSupervisor.listArtifacts(runId).filter((item) => item.type === "FINAL_DIFF" && item.trusted).at(-1);
          if (!artifact) throw new Error("Engineer reviewed diff is unavailable");
          return (engineerSupervisor.isOptionalHardeningChild(runId)
            ? engineerArtifactStore.readVerifiedExact(artifact) : engineerArtifactStore.read(artifact)).toString("utf8");
        }
        return workspaceManager.diff(sandbox.workspace);
      };
      const publicationDeskConnection = engineerSupervisor.resolutionDeskConnection();
      const gitPublicationMechanics = new GitPublicationMechanics({
        gitService: engineerGitService,
        // repositoryId -> durable repository reference (owner/name/provider/base
        // branch) via the latest run bound to it. Preflight overrides the base
        // commit with the approval's and reads the live remote head itself.
        resolveRepository: (repositoryId) => {
          try {
            const row = publicationDeskConnection
              .query("SELECT id FROM engineer_runs WHERE repository_id=? ORDER BY created_at DESC, id DESC LIMIT 1")
              .get(repositoryId) as { id: string } | null;
            if (!row) return null;
            return engineerSupervisor.getRun(row.id).repository;
          } catch {
            return null;
          }
        },
        // Server-derived run context + rich PR-body narrative from trusted
        // records only (never Builder text).
        resolvePublicationContext: (runId) => {
          try {
            const run = engineerSupervisor.getRun(runId);
            const manifest = engineerSupervisor.getManifest(runId);
            const evidence = engineerSupervisor.getPublicationEvidence(runId);
            return {
              repository: run.repository,
              title: run.requestNormalized || run.requestOriginal,
              narrative: {
                requestNormalized: run.requestNormalized ?? "",
                requestOriginal: run.requestOriginal,
                riskTier: run.riskTier,
                evidenceBundleHash: evidence.evidenceBundleHash,
                acceptanceCriteria: manifest?.acceptanceCriteria.map((item) => ({ statement: item.statement })) ?? [],
                diff: publicationDiffForRun(runId),
                claims: engineerSupervisor.listClaimEvidence(runId).map((claim) => ({ status: claim.status, claim: claim.claim })),
              },
            };
          } catch {
            return null;
          }
        },
      });
      engineerPublicationAuthorityService = engineerSupervisor.createPublicationAuthorityService({
        preflight: gitPublicationMechanics.preflightProbe,
        credentialProvider: { getPublicationCredentials: async () => ({ token: await currentGithubToken(false) }) },
        actuator: gitPublicationMechanics.createActuator(),
      });
    }
    recoverHardeningPaidCalls = () => {
      if(!engineerWorkerLeases||!hardeningPromptCacheSecret)return {recovered:[],errors:[]};
      return recoverHardeningPaidCallsOnce({supervisor:engineerSupervisor,workerLeases:engineerWorkerLeases,workerLeaseSecret});
    };
  }

  const log: LogFn = (level, message, fields = {}) => {
    // Redact any provider/secret token before the structured line is emitted —
    // an upstream error echoed into `fields` (e.g. a 401 body) can carry a key.
    const line = redactSecrets(
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        service: "gateway",
        message,
        ...fields,
      }),
    );
    if (level === "error") {
      console.error(line);
    } else {
      console.log(line);
    }
  };

  // Serper also powers search/research (handler tries Tavily → Serper), so
  // only warn when BOTH are absent — a Serper-only gateway works fine.
  if (!config.tavilyApiKey && !config.serperApiKey) {
    log(
      "warn",
      "Deep research unavailable: set TAVILY_API_KEY in apps/gateway/.env to enable",
      {},
    );
  }

  // Cancellation is the first recovery lane. It must converge before queued,
  // planning, verification, or paid-call recovery can revive ordinary work.
  for (const recovery of engineerRuns.recoverPendingCancellations()) {
    recovery.promise.catch((error) => {
      log("error", "engineer.cancellation_recovery_failed", {
        runId: recovery.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  // A hardening start may have committed its immutable seed authority just
  // before a process interruption. Reconstruct that exact cold seed and
  // finish the deterministic start before ordinary queued recovery scans.
  for (const recovery of engineerRuns.recoverOptionalHardeningStarts()) {
    recovery.promise.catch((error) => {
      log("error", "engineer.hardening_start_recovery_failed", {
        runId: recovery.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  // Reconcile paid-call crash windows before any ordinary workflow recovery.
  // This path has no provider transport and skips every child with a live
  // independent worker lease or paid-call execution fence.
  try {
    const sweep = recoverHardeningPaidCalls?.() ?? {recovered:[],errors:[]};
    if (sweep.recovered.length > 0) log("info", "engineer.hardening_paid_call_recovery", { recovered:sweep.recovered });
    for(const error of sweep.errors)log("error","engineer.hardening_paid_call_recovery_run_failed",{...error});
    for(const recovery of recoverOptionalHardeningAfterPaidReconciliation({runIds:sweep.recovered.map((item)=>item.runId),
      supervisor:engineerSupervisor,runs:engineerRuns,execution:engineerExecution}))
      recovery.promise.catch((error)=>log("error","engineer.hardening_post_recovery_resume_failed",{
        runId:recovery.runId,error:error instanceof Error?error.message:String(error),
      }));
  } catch (error) {
    log("error", "engineer.hardening_paid_call_recovery_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  // Optional verification recovery is a separate authority lane: reconstruct
  // and verify its signed start/seed/stage snapshot read-only, then acquire the
  // worker lease inside VerificationManager before any sandbox or state work.
  for(const recovery of engineerRuns.recoverOptionalHardeningVerification()){
    recovery.promise.catch((error)=>log("error","engineer.hardening_verification_recovery_failed",{
      runId:recovery.runId,error:error instanceof Error?error.message:String(error),
    }));
  }
  // P8 publication boot recovery (R3 finding 1d). A crash mid-DISPATCHED left a
  // durable DISPATCHED operation whose remote outcome was never settled. Park
  // each in RECONCILING (a human resolves the true remote state) — NEVER a
  // second PR. `resume` is idempotent, so a repeated restart converges without
  // re-dispatching.
  if (engineerPublicationAuthorityService) {
    try {
      for (const publicationId of engineerPublicationAuthorityService.listResumablePublications()) {
        try {
          const view = engineerPublicationAuthorityService.resume(publicationId);
          log("info", "engineer.publication_dispatch_recovery", { publicationId, state: view.state });
        } catch (error) {
          log("error", "engineer.publication_dispatch_recovery_failed", {
            publicationId, error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      log("error", "engineer.publication_dispatch_recovery_scan_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // QUEUED is the durable dispatch record. A gateway restart reclaims queued
  // work only after reading that committed state; failures are handled by the
  // execution manager's deterministic environment/Builder terminal paths.
  for (const recovery of engineerExecution?.recoverQueued() ?? []) {
    recovery.promise.catch((error) => {
      log("error", "engineer.recovery_failed", {
        runId: recovery.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  for (const recovery of engineerRuns.recoverPlanning()) {
    recovery.promise.catch((error) => {
      if (error instanceof BudgetPausedError) return;
      log("error", "engineer.planning_recovery_failed", {
        runId: recovery.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  for (const recovery of engineerVerification?.recoverReady() ?? []) {
    recovery.promise.catch((error) => {
      if (error instanceof BudgetPausedError) return;
      log("error", "engineer.verification_recovery_failed", {
        runId: recovery.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  // Graceful-shutdown state. `draining` is read by the handler's /health so
  // load balancers/clients stop routing new traffic here once shutdown begins.
  let draining = false;

  // Optional per-client rate limiter on the expensive POST endpoints. Disabled
  // unless GATEWAY_RATELIMIT_RPM is set to a positive value, so default
  // behaviour is unchanged for existing self-hosters.
  const rpm = Number(process.env.GATEWAY_RATELIMIT_RPM);
  const rateLimiter: RateLimiter | undefined =
    Number.isFinite(rpm) && rpm > 0
      ? createRateLimiter({
          limit: Math.floor(rpm),
          windowMs: 60_000,
          // Only trust X-Forwarded-For behind a known reverse proxy.
          trustProxy: /^(1|true)$/i.test(process.env.GATEWAY_TRUST_PROXY ?? ""),
        })
      : undefined;

  // Optional error sink (Sentry when SENTRY_DSN is set; otherwise undefined and
  // errors continue to flow only to the structured JSON log).
  const onError = createErrorSink(process.env, log);

  // P7 Developer Resolution Desk. Constructed on the ledger's SINGLE live
  // connection (so case/directive/apply transactions and the executable
  // replacement-run inserts are atomic with ledger writes and see the freeze
  // triggers in-transaction). The directive-signing secret is owner-only and
  // confined to this process — never handed to a model or sandbox. When the
  // secret authority is unavailable the desk is omitted and the routes report a
  // configured/not-configured 503 (never a wrong classification). The facade
  // derives the FULL CaseCreationInput from the durable terminal run server-side
  // (deriveCaseCreationInput) — the browser supplies no authority.
  let resolutionDesk: EngineerResolutionDeskFacade | undefined;
  const resolutionSigning = loadEngineerResolutionSigningAuthority({
    secretPath: join(engineerRoot, "resolution-directive-signing.secret"),
  });
  if (resolutionSigning.status === "READY") {
    // Bind the same gateway-held signing secret to the ledger so replacement-run
    // promotion / approval / publication authority is gated on verified lineage
    // (fail closed). The verifier reads the ledger's own connection — the same
    // one the desk writes replacement rows on.
    engineerSupervisor.configureResolutionSigningSecret(resolutionSigning.secret);
    // P11: bind the same gateway-held confined secret (distinct keyId) so a
    // durable APPROVE atomically emits + persists a signed provenance attestation
    // (see EngineerLedger.decideApproval). The secret never leaves this process.
    engineerSupervisor.configureProvenanceAttestationSigner(resolutionSigning.secret, `${resolutionSigning.keyId}:provenance`);
    const resolutionConnection = engineerSupervisor.resolutionDeskConnection();
    const resolutionPricingDigest = serverPricingPolicyDigest();
    const desk = new ResolutionDesk(
      resolutionConnection,
      resolutionSigning.secret,
      resolutionSigning.keyId,
      () => new Date(),
      new ResolutionReplacementRunFactory(),
    );
    const requireOwner = (ownerUserId: string): void => {
      // Owner-scoped: the durable run's owner must be the server engineer
      // principal. Cross-owner ids return the same not-found shape (no oracle).
      if (ownerUserId !== engineerPrincipal.ownerId) {
        throw Object.assign(new Error("resolution case not found"), { code: "CASE_NOT_FOUND", status: 404 });
      }
    };
    const readCaseEvents = (caseId: string): unknown[] => {
      const rows = resolutionConnection
        .query("SELECT payload_json FROM resolution_events WHERE case_id=? ORDER BY sequence")
        .all(caseId) as Array<{ payload_json: string }>;
      return rows.map((row) => JSON.parse(row.payload_json));
    };
    // Owner-scope EVERY read/mutate route, not just createCase (P12 Finding C /
    // Luna-2). The durable case (or the directive's case) records `owner_user_id`;
    // a caseId/directiveId owned by another user returns the same not-found shape
    // as an unknown id (no cross-owner oracle) BEFORE any desk read/mutation.
    const requireCaseOwner = (caseId: string): void => {
      const row = resolutionConnection
        .query("SELECT owner_user_id FROM resolution_cases WHERE id=?")
        .get(caseId) as { owner_user_id: string } | null;
      requireOwner(row?.owner_user_id ?? "");
    };
    const requireDirectiveOwner = (directiveId: string): void => {
      const row = resolutionConnection
        .query("SELECT c.owner_user_id AS owner_user_id FROM resolution_directives d JOIN resolution_cases c ON c.id=d.case_id WHERE d.id=?")
        .get(directiveId) as { owner_user_id: string } | null;
      requireOwner(row?.owner_user_id ?? "");
    };
    resolutionDesk = {
      createCase: (_principal, runId) => {
        const input = deriveCaseCreationInput(resolutionConnection, runId, { pricingPolicyDigest: resolutionPricingDigest });
        requireOwner(input.ownerUserId);
        return desk.createCase(input);
      },
      listCases: (_principal, runId) => {
        // The source run must be owned by the server principal, else not-found.
        const run = resolutionConnection.query("SELECT user_id FROM engineer_runs WHERE id=?")
          .get(runId) as { user_id: string } | null;
        requireOwner(run?.user_id ?? "");
        return desk.listCases(runId);
      },
      getCase: (_principal, caseId) => {
        requireCaseOwner(caseId);
        return { case: desk.getCase(caseId), events: readCaseEvents(caseId) };
      },
      issueDirective: (_principal, caseId, body, idempotencyKey) => {
        requireCaseOwner(caseId);
        return desk.issueDirective(caseId, body, idempotencyKey);
      },
      applyDirective: (_principal, directiveId, idempotencyKey) => {
        requireDirectiveOwner(directiveId);
        return desk.applyDirective(directiveId, idempotencyKey);
      },
    };
  } else {
    log("warn", "engineer.resolution_desk_unavailable", { detail: resolutionSigning.detail });
  }

  // P8 publication-authority facade. The routes forward JSON; this facade derives
  // ALL authority server-side (requester from the principal owner, approver from the
  // principal reviewer, idempotency from the header).
  //
  // Attestation posture (P12 Finding A): the v35 attestation binds a result git
  // TREE hash that is NOT durably recorded for a verified candidate and cannot be
  // sourced at publication time here, so attestation is FORMALLY DEFERRED behind
  // the explicit `ENGINEER_PROVENANCE_ATTESTATION_REQUIRED` flag (default OFF =
  // deferred; documented in KNOWN-LIMITATIONS.md). When ON, a durable APPROVE must
  // emit a v35 attestation or FAIL CLOSED (503, no P8 approval written), and if it
  // is ON without a configured signer the publication authority is WITHHELD
  // entirely (never fail-open). `resultTreeHashFor` still returns null (unsourced),
  // so with the flag ON, APPROVE fails closed until a real tree hash is wired.
  const provenanceAttestationRequired =
    /^(1|true)$/i.test(process.env.ENGINEER_PROVENANCE_ATTESTATION_REQUIRED ?? "");
  let publicationAuthority: EngineerPublicationAuthorityFacade | undefined;
  if (engineerPublicationAuthorityService && provenanceAttestationRequired && resolutionSigning.status !== "READY") {
    // Fail closed: attestation is REQUIRED by config but no signer authority is
    // available to emit it. Withhold the publication authority rather than run
    // fail-open; the routes report the configured/not-configured 503.
    log("error", "engineer.publication_attestation_required_without_signer", {
      detail: "ENGINEER_PROVENANCE_ATTESTATION_REQUIRED is set but no provenance signer is configured",
    });
  } else if (engineerPublicationAuthorityService) {
    publicationAuthority = createEngineerPublicationAuthorityFacade({
      service: engineerPublicationAuthorityService,
      principal: engineerPrincipal,
      connection: engineerSupervisor.resolutionDeskConnection(),
      now: () => new Date(),
      // [HUMAN] credential boundary: gate DISPATCH on a configured GitHub
      // credential. `publicationAuthorityReady` already requires one, so this is
      // normally true; when false, dispatch fails closed at PREFLIGHT.
      credentialAvailable: Boolean(githubToken?.trim()) || Boolean(options.githubTokenProvider && options.githubCredentialAvailable),
      attestationRequired: provenanceAttestationRequired && resolutionSigning.status === "READY",
      latestApprovalRequest: (runId) => {
        const request = engineerSupervisor.latestApprovalRequest(runId);
        return request ? {
          approvalRequestId: request.approvalRequestId, status: request.status,
          approvalRevision: request.approvalRevision, deadlineAt: request.deadlineAt,
          evidenceBundleHash: request.evidenceBundleHash,
          verifiedCheckpointId: request.verifiedCheckpointId ?? null,
          verifiedCheckpointHash: request.verifiedCheckpointHash ?? null,
        } : null;
      },
      decideApprove: (record, provenanceContext) => {
        engineerSupervisor.decideApproval(record as never, "APPROVED", provenanceContext);
      },
      // Fail-closed seam: the verified candidate's git result-tree hash is not
      // durably recorded and no gateway git-tree read is wired to v33 selections.
      resultTreeHashFor: () => null,
    });
  }

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: GATEWAY_HTTP_IDLE_TIMEOUT_SECONDS,
    fetch: createGatewayHandler({
      engine,
      config,
      log,
      onError,
      rateLimiter,
      activityStore,
      mcpRegistry,
      engineerRuns,
      resolutionDesk,
      publicationAuthority,
      getDraining: () => draining,
      // Real, in-flight-aware free-tier quota signal for Tokzen's quota-aware
      // compression dial (was always the hardcoded 1.0 default before wiring).
      getQuotaRemaining: (provider) => engine.getQuotaRemaining(provider),
      // Honest measured stats (p95 latency / throughput / uptime) behind the
      // OpenRouter-grade `/v1/models` stats block; null fields until enough samples.
      getProviderStats: (provider) => engine.getProviderStats(provider),
    }),
  });

  const unwatchPolicy = watchPolicy((next) => {
    engine.updatePolicy(next);
    log("info", "gateway.policy_reloaded", {
      modelGroups: Object.keys(next.modelGroups ?? {}).length,
      hasWeights: Boolean(next.providerWeights),
    });
  });

  // Optional background provider health probe (Phase 5.3). When
  // PROVIDER_PROBE_INTERVAL_MS is set, periodically validate each keyed provider
  // so an unreachable provider is demoted by health-aware routing before a real
  // request hits it. Off by default.
  let probeTimer: ReturnType<typeof setInterval> | null = null;
  let engineerWarmPoolTimer: ReturnType<typeof setInterval> | null = null;
  let engineerHardeningRecoveryTimer: ReturnType<typeof setInterval> | null = null;
  let engineerCancellationTimer: ReturnType<typeof setInterval> | null = null;
  if(engineerWorkerLeases){
    let sweepRunning=false;
    const sweep=()=>{
      if(sweepRunning)return;
      sweepRunning=true;
      let recoveries:ReturnType<EngineerRunManager["recoverPendingCancellations"]>;
      try{recoveries=engineerRuns.recoverPendingCancellations();}
      catch(error){
        sweepRunning=false;
        log("error","engineer.cancellation_recovery_failed",{
          error:error instanceof Error?error.message:String(error),
        });
        return;
      }
      void Promise.allSettled(recoveries.map((recovery)=>recovery.promise)).then((results)=>{
        results.forEach((result,index)=>{
          if(result.status!=="rejected")return;
          log("error","engineer.cancellation_recovery_failed",{
            runId:recoveries[index]?.runId,
            error:result.reason instanceof Error?result.reason.message:String(result.reason),
          });
        });
      }).finally(()=>{sweepRunning=false;});
    };
    engineerCancellationTimer=setInterval(sweep,10_000);
    engineerCancellationTimer.unref?.();
  }
  if (recoverHardeningPaidCalls) {
    let recoveryRunning = false;
    const sweep = () => {
      if (recoveryRunning) return;
      recoveryRunning = true;
      try {
        const result = recoverHardeningPaidCalls?.() ?? {recovered:[],errors:[]};
        if (result.recovered.length > 0) log("info", "engineer.hardening_paid_call_recovery", { recovered:result.recovered });
        for(const error of result.errors)log("error","engineer.hardening_paid_call_recovery_run_failed",{...error});
        for(const item of result.recovered){
          try{
            const run=engineerSupervisor.getRun(item.runId);
            if(run.state==="CANCELLATION_PENDING")engineerRuns.resumeCancellation(item.runId);
            else if(!run.terminalAt&&run.state!=="HUMAN_REVIEW_REQUIRED")
              for(const recovery of recoverOptionalHardeningAfterPaidReconciliation({runIds:[item.runId],
                supervisor:engineerSupervisor,runs:engineerRuns,execution:engineerExecution}))
                recovery.promise.catch((error)=>log("error","engineer.hardening_post_recovery_resume_failed",{
                  runId:recovery.runId,error:error instanceof Error?error.message:String(error),
                }));
          }catch(error){
            log("error","engineer.hardening_post_recovery_resume_failed",{runId:item.runId,
              error:error instanceof Error?error.message:String(error)});
          }
        }
      } catch (error) {
        log("error", "engineer.hardening_paid_call_recovery_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally { recoveryRunning = false; }
    };
    engineerHardeningRecoveryTimer = setInterval(sweep, 10_000);
    engineerHardeningRecoveryTimer.unref?.();
  }
  if (engineerWarmPool) {
    const configuredMinimum = Number(process.env.ZINTUS_ENGINEER_WARM_POOL_MIN);
    const configuredMaximum = Number(process.env.ZINTUS_ENGINEER_WARM_POOL_MAX);
    const maximum = Number.isInteger(configuredMaximum) && configuredMaximum >= 0 ? configuredMaximum : 8;
    const minimum = Number.isInteger(configuredMinimum) && configuredMinimum >= 0
      ? Math.min(configuredMinimum, maximum)
      : Math.min(1, maximum);
    let replenishing = false;
    const sweep = async () => {
      if (replenishing) return;
      replenishing = true;
      try {
        const health = engineerWarmPool?.sweep(maximum);
        if (health && (health.expiredQuarantined + health.invalidQuarantined + health.excessQuarantined > 0)) {
          log("info", "engineer.warm_pool_quarantined", { ...health });
        }
        if (health && health.available < minimum && engineerSandboxManager && engineerPrewarmConfig) {
          const baseCommitSha = engineerPrewarmConfig.getBaseCommitSha();
          engineerSandboxManager.prewarm({
            repositoryId: engineerPrewarmConfig.repositoryId,
            repositoryRoot: engineerPrewarmConfig.repositoryRoot,
            baseCommitSha,
          });
          log("info", "engineer.warm_pool_replenished", { availableBefore: health.available, minimum, maximum, baseCommitSha });
        }
      } catch (error) {
        log("error", "engineer.warm_pool_sweep_failed", { error: error instanceof Error ? error.message : String(error) });
      } finally {
        replenishing = false;
      }
    };
    engineerWarmPoolTimer = setInterval(() => { void sweep(); }, 60_000);
    engineerWarmPoolTimer.unref?.();
    void sweep();
  }
  // The legacy publication recovery + approval-expiration timer is RETIRED
  // (R5A). It previously drove the legacy manager's recover-pending sweep (which
  // resumed HUMAN_APPROVAL_PENDING runs) and its expire-approvals sweep on a 30s
  // interval. Neither fires now: P8 owns publication and has its own crash-safe
  // boot recovery above (listResumablePublications then resume, parking
  // DISPATCHED-but-unsettled operations in RECONCILING — never a second PR). No
  // timer double-acts with P8.
  const probeIntervalMs = Number(process.env.PROVIDER_PROBE_INTERVAL_MS);
  if (Number.isFinite(probeIntervalMs) && probeIntervalMs >= 1000) {
    const runProbe = () => {
      engine
        .probeProviders()
        .then((results) => {
          const down = results.filter((r) => !r.ok).map((r) => r.providerId);
          log("info", "gateway.provider_probe", {
            checked: results.length,
            down: down.length ? down.join(",") : "none",
          });
        })
        .catch((error) => {
          log("warn", "gateway.provider_probe_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    };
    probeTimer = setInterval(runProbe, probeIntervalMs);
    probeTimer.unref?.();
    runProbe(); // prime immediately on boot
  }

  const url = `http://${config.host}:${server.port}`;
  log("info", "gateway.listening", {
    url,
    auth: config.token ? "required" : "disabled",
    cors:
      config.corsOrigins === "*"
        ? "*"
        : config.corsOrigins === "loopback"
          ? "loopback (localhost + desktop + zintus.ai)"
          : config.corsOrigins.join(","),
  });
  if (!config.token) {
    log("warn", "gateway.auth_disabled", {
      hint:
        "No GATEWAY_TOKEN: API auth is disabled and CORS is restricted to " +
        "localhost / the desktop app / zintus.ai so other websites can't reach " +
        "this gateway. Set GATEWAY_TOKEN to require a bearer token (and allow any origin).",
    });
  }

  let shuttingDown: Promise<void> | null = null;
  async function shutdown(
    extraCleanup?: () => void | Promise<void>,
  ): Promise<void> {
    // Idempotent: a second signal during drain joins the in-flight shutdown.
    if (shuttingDown) {
      return shuttingDown;
    }
    shuttingDown = (async () => {
      draining = true; // /health -> 503 so clients stop routing here
      log("info", "gateway.draining", {});
      try {
        await extraCleanup?.();
      } catch (error) {
        log("warn", "gateway.cleanup_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (probeTimer) {
        clearInterval(probeTimer);
        probeTimer = null;
      }
      if (engineerWarmPoolTimer) {
        clearInterval(engineerWarmPoolTimer);
        engineerWarmPoolTimer = null;
      }
      if (engineerHardeningRecoveryTimer) {
        clearInterval(engineerHardeningRecoveryTimer);
        engineerHardeningRecoveryTimer = null;
      }
      if (engineerCancellationTimer) {
        clearInterval(engineerCancellationTimer);
        engineerCancellationTimer = null;
      }
      // Drain hosted MCP connections (stop the idle sweep + disconnect every
      // cached client, killing any stdio children) so a deploy doesn't leak them.
      try {
        await mcpRegistry.disconnectAll();
      } catch (error) {
        log("warn", "gateway.mcp_drain_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      unwatchPolicy();
      // Stop accepting new connections; let in-flight requests/streams finish,
      // but force-close after a bounded grace period so deploys don't hang.
      const drainMs = Number(process.env.GATEWAY_DRAIN_TIMEOUT_MS);
      const grace = Number.isFinite(drainMs) && drainMs >= 0 ? drainMs : DEFAULT_DRAIN_TIMEOUT_MS;
      const graceful = server.stop(false);
      let timer: ReturnType<typeof setTimeout> | null = null;
      const forced = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          log("warn", "gateway.drain_timeout", { graceMs: grace });
          void server.stop(true).finally(resolve);
        }, grace);
        timer.unref?.();
      });
      await Promise.race([graceful, forced]);
      if (timer) {
        clearTimeout(timer);
      }
      await engineerRuns.drain();
      log("info", "gateway.stopped", {});
      engineerWorkerLeases?.close();
      engineerWorkerLeases = undefined;
      engineerSupervisor.close();
    })();
    return shuttingDown;
  }

  return { server, config, url, shutdown };
}

/**
 * Install SIGTERM/SIGINT handlers that drive a graceful drain of the gateway
 * (and any extra cleanup, e.g. the cloud relay connection). A second signal
 * forces an immediate exit. Used by both the standalone entry below and the
 * `zintus serve` CLI command.
 */
export function installShutdownHandlers(
  running: RunningGateway,
  extraCleanup?: () => void | Promise<void>,
): void {
  let signalled = false;
  const handle = () => {
    if (signalled) {
      // Second signal: don't wait for the drain, exit now.
      process.exit(130);
    }
    signalled = true;
    void running
      .shutdown(extraCleanup)
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on("SIGTERM", handle);
  process.on("SIGINT", handle);
}

// Run directly (`bun run src/index.ts` / `zintus`'s `dev:gateway`).
if (import.meta.main) {
  const running = startGateway();
  installShutdownHandlers(running);
}
