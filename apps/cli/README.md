# zintus

Multi-provider AI CLI — route chat, code, and agent workloads across providers with quota-aware failover.

## Install

```bash
npm install -g zintus
# or
bun install -g zintus
```

> **Runtime requirement:** the `zintus` command runs on the [Bun](https://bun.sh) runtime
> (it uses `bun:sqlite`, `Bun.serve`, and other Bun APIs). Install Bun first:
> `curl -fsSL https://bun.sh/install | bash`. `npm install -g zintus` will place the
> `zintus` binary on your PATH, but invoking it requires Bun to be installed.

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
