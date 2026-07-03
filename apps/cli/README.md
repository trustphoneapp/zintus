# zintus

Multi-provider AI CLI — route chat, code, and agent workloads across providers with quota-aware failover.

## Install

```bash
npm install -g zintus
```

Nothing else to install — the npm package ships a **self-contained compiled
binary** for your platform (macOS arm64/x64, Linux x64/arm64, Windows x64) with
the runtime embedded. Stock Node ≥ 18 is only needed for the thin launcher npm
runs.

No npm? One line (macOS/Linux):

```bash
curl -fsSL https://zintus.ai/install | sh
```

Building from source instead requires [Bun](https://bun.sh) ≥ 1.2
(`bun install && bun run --cwd apps/cli dev`).

## Quick start

```bash
zintus setup            # first-run wizard: add API keys (stored in the OS keychain)
zintus "explain this error: ..."   # one-shot chat
zintus chat --mode smart "..."     # pick a routing mode (fast|smart|deep)
zintus serve            # run the local gateway the GUI/mobile clients connect to
zintus doctor           # check keychain, quota DB, provider keys, relay health
```

Run `zintus --help` for the full command list (`keys`, `config`, `history`, `trace`,
`cloud`, `remote`, `status`).

## Security

API keys are stored in your operating system's keychain via `@napi-rs/keyring`
(macOS Keychain, Windows Credential Manager, or libsecret on Linux) — never in
plaintext config files. Secrets are redacted from error output.

## License

[Business Source License 1.1](./LICENSE). Converts to Apache 2.0 on 2030-06-20.
