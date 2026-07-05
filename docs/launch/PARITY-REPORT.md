# Cross-platform parity — final report (feat/desktop-xplat-parity, 2026-07-05)

Phases 0–2 complete. 9 commits: blur fix → R1-R6 research → mirror docs →
S1-S6 implementation → logo unification. Everything below was verified as far
as one macOS machine + CI config can verify; the honest remainder is listed.

## Parity delta (before → after)

| Area | Before | After |
|---|---|---|
| Hairlines | 0.5px hardcoded — blurry at 1x and at Windows 125/150/175% | exactly 1 device px on every display (JS-driven `--hairline`, monitor-change aware, CSS fallback) |
| Font smoothing | forced `antialiased` everywhere | Retina keeps it; 1x gets engine default; Win/Linux native (property is mac-only) |
| Windows titlebar | native bar + in-app bar (double chrome), title text visible | undecorated + Zintus caption buttons (Fluent 46×32), drag regions, Ctrl+W |
| Linux titlebar | double chrome + dead 150px padding | native SSD kept (decision), padding fixed |
| Platform detection | `isMac` state defaulting true (SSR flash, wrong chrome) | `data-platform` stamp + CSS; **found+fixed: head init scripts never executed in the static export** (theme script was silently dead too) |
| Traffic-light overlap (user-reported) | brand under the lights (12px strip) | 44px strip restored — root cause was the dead stamp |
| color-mix CSS | **shipped bug**: minifier collapsed `color-mix(in oklch…)` to SOLID colors | guarded @supports block + precomputed theme-aware literals |
| open_external (Win) | legacy rundll32 | official opener plugin (ShellExecuteW) |
| Terminal shell (Win) | COMSPEC → cmd.exe | Windows PowerShell, cmd fallback |
| Keyring (Linux) | raw D-Bus error without Secret Service | actionable message; deb Recommends gnome-keyring |
| Installer config | defaults, ubuntu-latest CI | NSIS per-user + WebView2 bootstrapper; ubuntu-22.04 pin; SHA256SUMS |
| Verification | none off-macOS | ZINTUS_UI_SELFTEST hook + parity checker + desktop-verify.yml on 3 OSes; **full local pass on macOS** (platform/hairline/geometry/gateway/exit 0) |
| Logo | ArrowRight placeholder (desktop) | web Z-constellation mark everywhere (sidebar + membership badges) |

## What is NOT yet proven (no overclaiming)

1. **The 3-OS desktop-verify run**: triggered on push; the local `gh` token
   cannot read Actions (403) — check github.com/trustphoneapp/zintus/actions.
   Windows/Linux runtime behavior (caption buttons, ConPTY, WebView2 boot) is
   asserted by that workflow, not yet observed green.
2. Real-hardware smoke at Windows 125/150% scaling and on a Linux desktop —
   checklist items in WINDOWS-LAUNCH.md / LINUX-LAUNCH.md §2.
3. Mic/voice permission flows on WebView2/WebKitGTK (hardware-only).

## Consolidated [HUMAN] runbook (ordered)

1. Watch the `Desktop Verify` workflow on the branch — 3 jobs must go green;
   artifacts `ui-metrics-*` hold each OS's measured report.
2. Merge `feat/desktop-xplat-parity` when CI is green.
3. Windows signing: Azure Trusted Signing enrollment → secrets
   `AZURE_CLIENT_ID/SECRET/TENANT_ID` → activate `signCommand`
   (WINDOWS-LAUNCH.md §1) → one signed build on a clean VM.
4. macOS: Developer ID + notarization secrets (pre-existing item).
5. Updater: `bunx tauri signer generate` → pubkey into tauri.conf.json,
   private key + password into GH secrets → `createUpdaterArtifacts: true` +
   updater plugin + latest.json at releases.zintus.ai (R5). Never enable the
   plugin without the keys — it panics packaged builds.
6. Release: `git tag desktop-v0.3.0 && git push --tags` → release-desktop.yml
   produces mac/win/linux bundles + SHA256SUMS.
7. 30-min hardware smoke per WINDOWS-LAUNCH.md §2 / LINUX-LAUNCH.md §2.

## Signed-build quick commands

- macOS (after §4): tag push; CI signs + notarizes via env secrets.
- Windows (after §3): tag push; NSIS signed via signCommand.
- Linux: tag push; verify `sha256sum -c SHA256SUMS-x86_64-unknown-linux-gnu.txt`.
