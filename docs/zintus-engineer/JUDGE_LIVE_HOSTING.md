# Hosted Judge Live Mode

This mode exposes one bounded Zintus Engineer fixture run to invited judges. It
is not a general hosted gateway and must not be configured as one.

## What the web deployment enforces

- Invitation code exchange creates a signed, short-lived, `HttpOnly` session.
- The browser never receives `OPENAI_API_KEY` or `GATEWAY_TOKEN`.
- The same-origin proxy allows one run in that session, against the configured
  fixture repository only.
- The proxy overwrites every create request's budget with **$10**, **700,000
  tokens**, and **25 minutes**.
- A session can only read the run it created. It cannot list other judge runs.
- Publication, GitHub connector, Resolution Desk, budget top-up, and arbitrary
  gateway routes are denied before they reach the private gateway.

The gateway remains the final authority for its own global spend ledger,
repository admission, sandbox isolation, and model key.

## 1. Deploy the private gateway/controller

Use a Linux VM or container host that can run the existing pinned Docker
sandbox. Do not run it in Vercel and do not expose its Docker socket to a
builder sandbox.

Configure the gateway for exactly one fixture repository and its pinned image,
then bind its HTTPS endpoint to a dedicated hostname, for example
`https://engineer-gateway.example.com`.

Required gateway controls:

```text
GATEWAY_TOKEN=<random server-only value>
GATEWAY_RATELIMIT_RPM=<small cap>
ZINTUS_ENGINEER_REPOSITORY_ID=<judge fixture id>
ZINTUS_ENGINEER_REPOSITORY_ROOT=<fixture path on the controller>
ZINTUS_ENGINEER_IMAGE=<pinned image@sha256:...>
ZINTUS_ENGINEER_IMAGE_DIGEST=sha256:...
# plus the existing exact-base, dependency-bundle, and toolchain configuration
```

Use a dedicated restricted OpenAI project key on that controller only. Leave
publication credentials unset: a judge run may not create a PR, push, or merge.

## 2. Generate private deployment values

Run locally; do not paste the resulting secrets into source control:

```bash
openssl rand -hex 32                 # gateway token
openssl rand -base64 48              # judge session secret
printf %s 'your-invitation-code' | shasum -a 256
```

The third command produces `ZINTUS_JUDGE_ACCESS_CODE_HASH`. Store the original
invitation code only in the private judge instructions.

## 3. Create the Vercel web project

Import the Zintus repository, set its **Root Directory** to `apps/web`, and
configure these Production environment variables:

```text
NEXT_PUBLIC_GATEWAY_URL=/api/judge/gateway
NEXT_PUBLIC_SITE_URL=https://<your-vercel-domain>

ZINTUS_JUDGE_DEMO_ENABLED=1
ZINTUS_JUDGE_GATEWAY_URL=https://engineer-gateway.example.com
ZINTUS_JUDGE_GATEWAY_TOKEN=<gateway token from step 2>
ZINTUS_JUDGE_SESSION_SECRET=<session secret from step 2>
ZINTUS_JUDGE_ACCESS_CODE_HASH=<sha256 hex from step 2>
ZINTUS_JUDGE_FIXTURE_REPOSITORY_ID=<exact configured fixture id>
ZINTUS_JUDGE_RUN_COST_USD=10
ZINTUS_JUDGE_RUN_TOKEN_BUDGET=700000
ZINTUS_JUDGE_RUN_TIME_SECONDS=1500
ZINTUS_JUDGE_SESSION_TTL_SECONDS=1200
ZINTUS_JUDGE_MAX_REQUEST_CHARS=6000
```

Do **not** set `NEXT_PUBLIC_GATEWAY_TOKEN`, `NEXT_PUBLIC_OPENAI_API_KEY`, or
`OPENAI_API_KEY` in the Vercel project.

## 4. Verify before sharing

1. Open `/judge` in an incognito browser.
2. Confirm the replay is visible without any credential.
3. Submit a wrong access code: it must fail without a gateway call.
4. Submit the correct code: it must redirect to `/engineer` and show the fixed
   `$10 · 700k · 25 min` Judge live budget.
5. Create exactly one small fixture run.
6. Confirm a second create is refused and publication controls are unavailable.
7. Confirm the gateway ledger and OpenAI project show the expected bounded use.
8. Remove/revoke the access code and restrict/revoke the event OpenAI key after
   judging.

## Out of scope by design

- Arbitrary repository URLs or browser folder execution
- Persistent judge accounts or multi-tenant history
- Public direct gateway access
- GitHub publishing, deployment, merge, or credential delegation
