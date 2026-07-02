import { spawnSync } from "node:child_process";
import type { RunCommandResult, RunCommandSpawn } from "./agent-tools.js";

/**
 * P3 — an optional Docker-sandboxed `RunCommandSpawn` (Manus-parity where it's
 * cheap). The agent's run_command already takes an injectable spawner
 * (`AgentRunConfig.spawn`); this wraps the SAME allowlisted argv in
 * `docker run --rm` with the sandbox root bind-mounted read-write at /workspace
 * and hardened flags (no network, dropped caps, non-root, memory/pids caps).
 *
 * The allowlist + argv-only + budget + confirm gate in agent-tools.ts are
 * UNCHANGED and still enforced BEFORE this spawner ever runs — Docker is an
 * extra isolation layer around an already-constrained command, not a new way
 * to run arbitrary things. Escaping the container still lands you in the
 * mounted workspace only.
 *
 * `--network none` by default: verify commands (bun test/typecheck/lint/build)
 * don't need network, and denying it removes the biggest blast radius. Pass
 * `network: true` for the rare case a build must fetch.
 */
export interface DockerSandboxOptions {
  /** Container image with the toolchain (must have `bun`). */
  image?: string;
  /** Host directory mounted at /workspace (defaults to the run's cwd). */
  hostRoot?: string;
  /** Allow container network access (default false — fully offline). */
  network?: boolean;
  /** Container memory cap (docker `--memory`, default "2g"). */
  memory?: string;
  /** Injectable spawn for tests (defaults to node:child_process spawnSync). */
  rawSpawn?: typeof spawnSync;
}

/** Is a Docker daemon reachable? Cheap `docker info` probe (used to fail with a
 *  clear message instead of a cryptic ENOENT when --sandbox is requested). */
export function dockerAvailable(rawSpawn: typeof spawnSync = spawnSync): boolean {
  try {
    const res = rawSpawn("docker", ["info", "--format", "{{.ServerVersion}}"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

/** Build the `docker run …` argv that wraps an allowlisted command argv. */
export function buildDockerArgv(
  commandArgv: string[],
  opts: Required<Omit<DockerSandboxOptions, "rawSpawn">> & { workdir: string },
): string[] {
  return [
    "run",
    "--rm",
    opts.network ? "--network=default" : "--network=none",
    "--memory",
    opts.memory,
    "--pids-limit",
    "512",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    // Run as an unprivileged uid; the bind-mounted workspace must be writable
    // by it (docker-desktop maps this transparently; on Linux the caller's uid
    // should own hostRoot).
    "--user",
    "1000:1000",
    "-v",
    `${opts.hostRoot}:/workspace:rw`,
    "-w",
    "/workspace",
    opts.image,
    ...commandArgv,
  ];
}

/**
 * Create a `RunCommandSpawn` that executes each allowlisted command inside a
 * fresh, network-isolated container. `cwd` passed by the caller is the sandbox
 * root and becomes the bind mount, so relative paths behave identically to the
 * host spawner.
 */
export function createDockerSpawn(options: DockerSandboxOptions = {}): RunCommandSpawn {
  const rawSpawn = options.rawSpawn ?? spawnSync;
  const image = options.image ?? "oven/bun:1";
  const network = options.network ?? false;
  const memory = options.memory ?? "2g";

  return (argv, opts): RunCommandResult => {
    const hostRoot = options.hostRoot ?? opts.cwd;
    const dockerArgv = buildDockerArgv(argv, {
      image,
      hostRoot,
      network,
      memory,
      workdir: "/workspace",
    });
    const res = rawSpawn("docker", dockerArgv, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      shell: false,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    const timedOut =
      res.error != null &&
      (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
    const stderr =
      res.error && !timedOut
        ? `${res.stderr ?? ""}\n${res.error.message}`
        : (res.stderr ?? "");
    return {
      code: res.status,
      stdout: res.stdout ?? "",
      stderr,
      timedOut,
    };
  };
}
