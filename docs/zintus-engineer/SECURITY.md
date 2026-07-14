# Zintus Engineer security boundary

Phase 2 treats the repository and every model response as untrusted data.

## Builder permissions

The Codex Builder receives the frozen manifest and five strict functions: list
scoped files, read a scoped file, write a scoped file, request an exact manifest
command, and read the current Git diff. It receives no shell, environment, network,
Git credential, push, PR, merge, deployment, branch-protection, audit, database, or
workflow-transition capability. OpenAI requests use `store:false`; the API key stays
inside the gateway transport and never enters prompts or artifacts.

Paths are repository-relative, must match `allowedPaths`, must not match
`deniedPaths`, and can never enter `.git`. Absolute paths, `..`, unsafe segments,
and symlinks are rejected. File size and mutation counts are bounded.

## Trusted executor

A command must exactly match `allowedCommands`, must not match
`prohibitedCommands`, and must pass the deterministic package-runner policy. Tokens
with shell metacharacters are rejected. Commands are spawned as argv with
`shell:false` and a minimal non-secret environment.

Docker execution is pinned by image digest and uses:

- no network;
- read-only container root;
- a single run worktree mounted at `/workspace`;
- non-root UID/GID;
- all Linux capabilities dropped;
- `no-new-privileges`;
- bounded CPUs, memory, PIDs, runtime, and output;
- a bounded, no-exec temporary filesystem.

Exit code, timing, environment digest, commit SHA, and stdout/stderr artifact IDs
are recorded by deterministic code. Agent prose never substitutes for those rows.

## Workspace lifecycle

Cold workspaces are Git worktrees created at the exact frozen base SHA. Warm pool
metadata is filesystem-backed and atomically renamed from available to claimed.
Before use, a warm workspace is reset and cleaned, then checked for a clean status,
exact base, repository origin, lockfile hash, image digest, toolchain hash, network
policy, and sandbox policy. Invalid claims are quarantined and fall back to cold
provisioning. A claimed workspace is destroyed and never returned to the pool.

## Remaining security gates

Phase 3 adds independent tests, security scans, fresh Reviewer isolation, and
claim-to-evidence validation. Phase 4 adds the narrow credentialed publication
service. Until those gates exist, Phase 2 stops at `FAST_CHECKS` and cannot publish.
