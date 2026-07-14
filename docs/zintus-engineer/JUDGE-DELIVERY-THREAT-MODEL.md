# Judge delivery architecture and threat model

Status: architecture frozen; credential/budget authority pending human confirmation.

Recorded: 2026-07-14

## Decision

The primary judge artifact is a **digest-pinned, signed local OCI bundle** for one
fixture repository. It exposes two explicitly labeled modes:

1. `replay`: starts without a key and renders a signed, redacted candidate trace; it
   remains `PENDING_PROVENANCE` until provider and canary evidence prove a genuine
   prior GPT-5.6 run;
2. `live`: executes the bounded fixture with separately provisioned, revocable event
   credentials supplied at runtime through private judge instructions.

There is no multi-tenant hosted control plane, cloud database, embedded credential,
arbitrary-repository execution, automatic merge or deployment in the Build Week path.

## Supported boundary

| Component | Trust level | Boundary |
|---|---|---|
| Signed controller/gateway/UI bundle | trusted release artifact | bound to release SHA and OCI digest |
| Browser session | authenticated local judge | server-minted HttpOnly session; request-body actor fields have no authority |
| Fixture repository | untrusted content | exact read-only base plus per-run isolated write workspace |
| Builder sandbox | untrusted code execution | pinned image, non-root, offline, resource-limited, no Docker socket or host secrets |
| Host Docker controller | high privilege | accessible only to trusted controller; never mounted into Builder sandbox |
| SQLite/evidence store | trusted local record | unique judge/run namespace, append-only records and hash-bound artifacts |
| OpenAI project credential | secret external authority | runtime-only, separate event project, revocable and spend-limited |
| GitHub credential | secret publication authority | fine-grained token/App limited to one disposable repository and PR permissions |
| Signed replay bundle | trusted demonstration record | redacted, hash-bound and visibly labeled `REPLAY` |

Supported clean-machine targets are macOS with Docker Desktop and Linux with Docker
Engine. Windows is supported only through a separately rehearsed WSL2 path; it is not
claimed until that rehearsal passes.

## Credential flow

- Secrets are never copied into the OCI image, repository, trace, browser storage,
  command arguments or persisted model/evidence records.
- `live` mode accepts a controller-only secret file in a `0700` directory with mode
  `0600`, opens it by file descriptor, unlinks it after loading and scrubs the launch
  environment. The controller builds an allowlisted environment for every child;
  Builder, verifier, Git commands and Docker containers never inherit either secret.
- Before opening, the launcher uses `lstat` and rejects anything except a regular file
  owned by the effective user, with exact mode `0600`, whose parent is owned by that
  user with exact mode `0700`. It opens with `O_RDONLY|O_CLOEXEC|O_NOFOLLOW`, then
  `fstat`s and matches device/inode to close the check/use race. Symlinks, a hard-link
  count above one and files larger than 16 KiB fail closed.
- The file is parsed as data, never sourced by a shell. UTF-8 lines must contain exactly
  the two unique keys `OPENAI_API_KEY` and `GITHUB_TOKEN`; missing, duplicate, unknown,
  empty, NUL/CR-containing or malformed entries fail before either credential is used.
  Expansion, command substitution, quoting and escape interpretation are forbidden.
- The OpenAI credential belongs to a dedicated non-human project service identity in
  a dedicated event project; a personal/user key is forbidden. It must be Restricted
  to `/v1/responses` Write and `/v1/models` Read with every other endpoint None.
  Project Model Usage permits only `gpt-5.6-sol`, `gpt-5.6-terra` and `gpt-5.6-luna`,
  with per-model rate limits. Preflight records project/key identifiers in redacted
  form and rejects broader permissions.
- OpenAI documents Restricted key endpoint permissions and project Model Usage/rate
  limits. If the account UI cannot express the required endpoint/model restrictions,
  including for the chosen service identity, live judge activation fails rather than
  falling back to a broader or personal key.
- Provider budget settings are alerts/defense-in-depth, not the authoritative cap.
  The local ledger atomically reserves against an aggregate $75 event ceiling across
  all runs, plus the $8 run cap, before a call; it reconciles actual provider usage,
  releases unused reservation and revokes/disables the key at the local ceiling.
- Each call reserves worst-case cost from the exact model price version using the input
  cap at cache-write price, maximum output (including reasoning tokens) and applicable
  long-context rate. Missing or untrusted provider usage retains the full reservation,
  emits `PROVIDER_USAGE_MISSING`, stops the run and forbids later calls. Only an
  authoritative reconciliation may lower that reservation.
- The GitHub fine-grained token has exactly: Metadata Read, Contents Read/Write and
  Pull requests Read/Write on one disposable fixture repository. Every other repository
  and permission is None. It cannot access Zintus source, Actions, administration,
  environments, releases, packages, deployments, issues, workflows or secrets.
- A random bootstrap/session secret is minted locally per clean start and never comes
  from the credential file. Server-side identity owns start,
  answer, approval, cancellation and publication actions.
- Credentials remain revocable throughout judging and are revoked after Aug 5 closeout.

Official key-security constraint: never use or distribute a personal or unrestricted
key. The restricted service-identity event-key delivery remains pending
organizer/entrant approval; if private delivery or required restriction is not
permitted, local live mode is NO-GO rather than silently using a broader key.

## Local browser boundary

- Gateway and UI bind only to `127.0.0.1`/`::1`; wildcard and LAN binding fail preflight.
- Requests must match an exact Host and Origin allowlist for the printed ephemeral port.
- State-changing routes require a synchronizer CSRF token bound to the session.
- The bootstrap URL contains a single-use high-entropy nonce. Redemption rotates the
  session ID and returns an `HttpOnly`, `Secure` where TLS is used, `SameSite=Strict`
  cookie; nonce reuse and session fixation fail.
- Session rotation occurs after approval/publication and reset. CORS is disabled and
  responses set restrictive CSP, frame, MIME and referrer headers.

## Isolation and reset

- Every live run receives a new run ID, workspace, SQLite namespace and artifact root.
- Warm sandboxes are health-checked, atomically claimed once and destroyed after use;
  pool health is never verification evidence.
- Fixture dependencies are preloaded in the pinned image; sandbox networking is off.
- Reset cancels the worker, destroys the sandbox, removes the run workspace and clears
  the browser session. Immutable redacted release evidence remains separate.
- Reset terminates the credential-bearing controller process, closes its listening
  socket/file descriptors and waits for exit before reporting success. The launcher
  runs `verify-clean` out of process and proves that controller PID/socket and every
  descendant are gone; replay/live requires a fresh controller. Core dumps are disabled
  and credential buffers are zeroed best-effort before process exit.
- TTL cleanup is a fallback, not the primary reset mechanism.
- The controller accepts only the frozen fixture/task catalog in judge mode.

Builder containers are created from a constant argv template with no user-derived
Docker flags and the equivalent of:

```text
--user 65532:65532
--read-only
--cap-drop ALL
--security-opt no-new-privileges=true
--security-opt seccomp=<pinned-profile>
--pids-limit 256
--cpus 2
--memory 4g
--network none
--tmpfs /tmp:rw,noexec,nosuid,size=256m
```

AppArmor is required on supported Linux hosts when available and pinned in the release
manifest. Privileged mode, devices, host PID/IPC/network namespaces, Docker socket and
host-path mounts are forbidden. The only writable mount is the per-run workspace;
source/base, tools and policy mounts are read-only.

## OCI trust and provider provenance

- Release images are signed with Sigstore keyless signing from the pinned GitHub Actions
  release workflow. Verification pins the Fulcio issuer and exact repository/workflow
  certificate identity, Rekor inclusion and OCI digest.
- The expected digest and verification identity are independently copied into the
  Devpost entry, private judge instructions and provenance record. The launcher fails
  closed before create/start when any value or signature differs.
- The standalone `zintus-judge` launcher and its Sigstore bundle are distributed with
  an independently recorded SHA-256. The operator verifies its digest, Fulcio issuer,
  exact workflow certificate identity and Rekor entry before executing it. An
  unverified launcher may not verify or start the OCI artifact.
- A publisher signature proves artifact origin, not that a replay came from OpenAI.
  Genuine-run evidence additionally requires the redacted provider response/request ID,
  exact model ID, provider usage buckets, local request hash, run/evidence hashes and
  a canary scan. Until those exist, the replay is labeled `PENDING_PROVENANCE` and is
  not a submission artifact.

## Threats and required controls

| Threat | Required control | Acceptance evidence |
|---|---|---|
| Secret embedded in artifact | build-time secret scan plus clean extraction inspection | seeded canary and credential patterns absent from every layer, bundle, trace and repo; claim pending this evidence |
| Secret leaks through logs/model | central redaction before persistence/display; no secrets in prompts | seeded canary absent from exported trace, SQLite and model request capture |
| Stolen event credential | separate project/repo scope, spend cap, revocation runbook | revoke test stops new work without corrupting prior evidence |
| Cost/concurrency abuse | server-derived session, one live run, pre-call reservation, wall-time/TTL caps | second concurrent start and over-budget reservation fail before a call |
| Arbitrary repository exfiltration | frozen fixture catalog; no user repository URL/path in judge mode | traversal, alternate remote and symlink fixtures fail before checkout |
| Cross-run data bleed | unique namespaces, single-use sandbox, ownership/hash checks | run B cannot read run A decisions, workspace or artifacts |
| Repository prompt injection | repository text remains untrusted data with strict schemas/tools | sentinel cannot create command, permission, decision or evidence claim |
| Docker privilege escalation | Docker socket available only to trusted controller; Builder non-root/offline | Builder cannot reach daemon/socket, host filesystem or network |
| Spoofed approval/publication actor | server-minted owner/reviewer; ignore client actor claims | actor-field tampering returns forbidden/conflict and creates no event |
| Tampered OCI/replay | publish SHA, OCI digest, signature and evidence hashes | modified artifact or trace fails verification before start/display |
| Replay presented as live | permanent `REPLAY` badge and recorded run metadata | screenshots/export retain mode label and source run ID |
| Excess GitHub authority | fine-grained disposable-repo token and Supervisor-only publication | token cannot access another repo; duplicate/stale publication is idempotent |
| Residual data after reset | deterministic teardown plus TTL sweep | post-reset search finds no run workspace/session/secret residue |
| Forged provider provenance | provider request/response ID + usage + local hashes, distinct from publisher signature | replay remains `PENDING_PROVENANCE` until all records reconcile |
| Malicious secret-file path/data | owner/mode/regular-file checks, `O_NOFOLLOW`, strict two-key non-shell parser | symlink, hard link, wrong owner/mode, oversized, duplicate/unknown/malformed key all fail before use |
| Credential-bearing process survives | reset terminates controller/descendants and closes socket before out-of-process check | PID/socket/process-environment checks are empty after reset |

## Judge modes

### Replay mode

- Requires no personal API key or GitHub credential.
- Demonstrates the exact UI, decisions, failure, repair, evidence, Reviewer and cost
  records from one signed live run.
- Cannot be described as a fresh execution.

### Restricted live mode

- Requires the event credentials delivered privately, not the judge's personal keys.
- Executes only the pinned fixture and can publish only to its disposable repository.
- Must pass a zero-cache second-account rehearsal before release.
- A missing/expired credential fails preflight without partial mutation or a false
  success state.

## Human authority required

Before this architecture may be marked approved, the entrant must confirm:

1. the digest-pinned local bundle is the primary judge path;
2. the restricted event credential may be provisioned privately and revoked;
3. the local aggregate ledger may enforce a $75 hard cap and the OpenAI event project
   may carry a $50 provider-side alert;
4. the disposable GitHub repository/App or fine-grained token may be created with the
   scope above;
5. Docker may be installed/used on the build and rehearsal machines.

No approval is inferred from the existence of this document. Until confirmed, D0-04
is architecture-complete but remains `BLOCKED_HUMAN` for activation.

Clean-machine commands, supported host requirements and zero-cache evidence are defined
in `JUDGE-DELIVERY-RUNBOOK.md`; unexecuted checklist items are not release claims.
