# Judge delivery clean-machine runbook

Status: command contract frozen; release digest and zero-cache evidence pending D5.

## Supported host contract

| Requirement | macOS | Linux |
|---|---|---|
| Architecture | `arm64` or `amd64` | `arm64` or `amd64` |
| Container runtime | Docker Desktop with Compose v2 | Docker Engine with Compose v2 |
| Resources available to Docker | 8 GB RAM, 4 CPUs, 12 GB free disk | 8 GB RAM, 4 CPUs, 12 GB free disk |
| Browser | current stable Chromium, Chrome, Safari or Firefox | current stable Chromium, Chrome or Firefox |
| Bootstrap tools | `curl >=8`; SHA-256 via LibreSSL 3.3+ or OpenSSL 3+ | `curl >=8`; OpenSSL 3+ |
| Signature verifier | pinned Cosign `v3.1.1`, bootstrapped below | pinned Cosign `v3.1.1`, bootstrapped below |

The release manifest records the exact Docker/Compose versions rehearsed on each host.
The doctor command fails unknown/older runtimes on capability checks rather than claiming
unverified compatibility. Windows/WSL2 is excluded until a separate rehearsal passes.

Outbound bootstrap/replay access is allowlisted to `github.com`,
`release-assets.githubusercontent.com` and `objects.githubusercontent.com` for the
Cosign release/redirect chain, `ghcr.io` and
`pkg-containers.githubusercontent.com` for OCI content, and `rekor.sigstore.dev`,
`fulcio.sigstore.dev` and `tuf-repo-cdn.sigstore.dev` for Sigstore verification. Live
mode additionally permits only `api.openai.com`, `api.github.com` and `github.com` from
the trusted controller. Builder sandbox networking remains `none`.

## Bootstrap the signature verifier

Download the platform-specific Cosign `v3.1.1` binary from the official
`sigstore/cosign` GitHub release. Its expected SHA-256 is copied independently into the
Devpost entry and private judge instructions; never take that hash from the Zintus
bundle being verified.

```bash
export COSIGN='./cosign-v3.1.1'
export COSIGN_SHA256='<platform-specific-sha256-from-devpost>'
curl --fail --location --proto '=https' --tlsv1.2 \
  --output "$COSIGN" \
  'https://github.com/sigstore/cosign/releases/download/v3.1.1/<cosign-platform-binary>'
test "$(openssl dgst -sha256 "$COSIGN" | awk '{print $NF}')" = "$COSIGN_SHA256"
chmod 0755 "$COSIGN"
"$COSIGN" version
```

The runbook never trusts an ambient `cosign`. D5 begins on a host with neither source
nor Cosign preinstalled and retains the download/hash transcript.

## Values distributed in judge instructions

```bash
export ZINTUS_ENGINEER_IMAGE='ghcr.io/trustphoneapp/zintus-engineer@sha256:<release-digest>'
export ZINTUS_ENGINEER_CERT_IDENTITY='https://github.com/trustphoneapp/zintus/.github/workflows/release.yml@refs/tags/<release-tag>'
export ZINTUS_ENGINEER_CERT_ISSUER='https://token.actions.githubusercontent.com'
export ZINTUS_JUDGE_LAUNCHER='./zintus-judge'
export ZINTUS_JUDGE_LAUNCHER_SHA256='<launcher-sha256>'
export ZINTUS_JUDGE_LAUNCHER_BUNDLE='./zintus-judge.sigstore.json'
```

Place live secrets, when authorized, in a temporary directory readable only by the
current user:

```bash
umask 077
mkdir -p "$HOME/.zintus/judge-secrets"
chmod 700 "$HOME/.zintus/judge-secrets"
${EDITOR:-vi} "$HOME/.zintus/judge-secrets/live.env"
chmod 600 "$HOME/.zintus/judge-secrets/live.env"
```

The file contains only the restricted event OpenAI service-identity key and the
fine-grained disposable-repository GitHub token. The controller always mints the
bootstrap/session secret locally. Never paste secrets into the browser or command
arguments. The launcher consumes and unlinks this file; use a fresh file for a later
run.

The launcher rejects a symlink or non-regular secret file, wrong owner, directory mode
other than `0700`, file mode other than `0600`, link count above one and size above
16 KiB. It never sources the file: the only accepted unique, nonempty keys are
`OPENAI_API_KEY` and `GITHUB_TOKEN`; unknown, duplicate, missing, NUL/CR-containing or
malformed lines stop before the controller starts.

## Verify before pulling/running

```bash
test "$(openssl dgst -sha256 "$ZINTUS_JUDGE_LAUNCHER" | awk '{print $NF}')" = \
  "$ZINTUS_JUDGE_LAUNCHER_SHA256"
"$COSIGN" verify-blob \
  --bundle "$ZINTUS_JUDGE_LAUNCHER_BUNDLE" \
  --certificate-identity "$ZINTUS_ENGINEER_CERT_IDENTITY" \
  --certificate-oidc-issuer "$ZINTUS_ENGINEER_CERT_ISSUER" \
  "$ZINTUS_JUDGE_LAUNCHER"
docker version
docker compose version
"$COSIGN" verify \
  --certificate-identity "$ZINTUS_ENGINEER_CERT_IDENTITY" \
  --certificate-oidc-issuer "$ZINTUS_ENGINEER_CERT_ISSUER" \
  "$ZINTUS_ENGINEER_IMAGE"
docker pull "$ZINTUS_ENGINEER_IMAGE"
docker image inspect "$ZINTUS_ENGINEER_IMAGE" --format '{{json .RepoDigests}}'
```

The launcher SHA-256/signing identity and image digest must match the Devpost entry,
private instructions and provenance record. Any mismatch stops before the launcher or
image executes.

## Preflight and start

The release bundle supplies a signed `zintus-judge` launcher. These commands are the
required interface; D5 must prove they work from a machine without the source tree:

```bash
./zintus-judge doctor --image "$ZINTUS_ENGINEER_IMAGE"
./zintus-judge replay --image "$ZINTUS_ENGINEER_IMAGE"
./zintus-judge live \
  --image "$ZINTUS_ENGINEER_IMAGE" \
  --secret-file "$HOME/.zintus/judge-secrets/live.env"
```

The launcher prints a single-use loopback bootstrap URL. `replay` must show `REPLAY` or
`PENDING_PROVENANCE`; `live` must show `LIVE`. It never prints a credential.

## Reset and remove

```bash
./zintus-judge reset --all
./zintus-judge verify-clean
docker image rm "$ZINTUS_ENGINEER_IMAGE"
rm -rf "$HOME/.zintus/judge-secrets"
```

`verify-clean` fails if a worker/container, workspace, session, secret file, unexpected
volume/network or unredacted canary remains. Reset first terminates and reaps the
credential-bearing controller and descendants, closes the loopback socket and discards
credential memory. `verify-clean` runs outside that process and confirms its PID/socket
are absent. It does not delete the signed public replay.

## Required D5 evidence

- zero-cache transcript from each supported architecture/runtime actually claimed;
- signature and digest verification output;
- replay start/reset/remove without credentials;
- restricted live run from a second account without a personal key;
- canary absent from image layers, process environments, child environments, logs,
  SQLite, trace and browser storage;
- exact provider request/response ID and usage reconciliation for the signed replay;
- over-budget, second-concurrent-run, alternate-repository and expired-key rejection;
- no residual containers, workspaces, volumes, sessions or secret files after cleanup;
- negative secret ingestion for symlink/hard link, wrong owner/mode, oversized input,
  duplicate/unknown/missing/malformed keys and shell-looking values;
- controller/descendant PID, socket, file descriptor and credential-bearing process
  state absent after reset.

Until this evidence is attached, the runbook is a test contract, not a claim that the
judge artifact is available.
