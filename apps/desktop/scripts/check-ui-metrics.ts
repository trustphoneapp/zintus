#!/usr/bin/env bun
/**
 * S6 parity gate: asserts the UI metrics report produced by the app's
 * ZINTUS_UI_SELFTEST hook (src-tauri/src/lib.rs SELFTEST_JS) against the
 * cross-platform spec in docs/launch/PLATFORM-PARITY.md. The same numbers
 * must hold on macOS, Windows, and Linux — that equality IS the "same
 * buttons, same dimensions" guarantee, enforced per-OS in CI
 * (.github/workflows/desktop-verify.yml).
 *
 * Usage: bun scripts/check-ui-metrics.ts <report.json>
 */
import { readFileSync } from "node:fs";

type Box = { w: number; h: number } | null;
type Report = {
  error?: string;
  platform: "mac" | "windows" | "linux" | null;
  dpr: number;
  hairline: string;
  topbar: Box;
  titlebarStrip: Box;
  iconBtn: Box;
  winControls: Box;
  probeButton: Box;
  gateway: { ok?: boolean } | null;
};

const path = process.argv[2];
if (!path) {
  console.error("usage: bun scripts/check-ui-metrics.ts <report.json>");
  process.exit(2);
}
const report = JSON.parse(readFileSync(path, "utf8")) as Report;
if (report.error) {
  console.error(`selftest reported an error: ${report.error}`);
  process.exit(1);
}

const failures: string[] = [];
const close = (a: number | undefined, b: number, tol = 0.75) =>
  typeof a === "number" && Math.abs(a - b) <= tol;
const expect = (name: string, cond: boolean, detail: string) => {
  if (!cond) failures.push(`${name}: ${detail}`);
};

expect(
  "platform stamp",
  report.platform === "mac" || report.platform === "windows" || report.platform === "linux",
  `got ${JSON.stringify(report.platform)}`,
);

// Hairline must be exactly one device pixel (R2 / lib/hairline.ts).
const wantHairline = `${Math.round(10000 / report.dpr) / 10000}px`;
expect(
  "hairline = 1 device px",
  report.hairline === wantHairline,
  `got "${report.hairline}", want "${wantHairline}" at dpr ${report.dpr}`,
);

// Shared chrome — identical CSS px on every OS (R4: one branded size set).
expect("topbar height 52", close(report.topbar?.h, 52), `got ${report.topbar?.h}`);
expect(
  "icon button 32×32",
  close(report.iconBtn?.w, 32) && close(report.iconBtn?.h, 32),
  `got ${report.iconBtn?.w}×${report.iconBtn?.h}`,
);
// Global button: 13px/600 bundled Inter (normal line-height ≈16px) + 8px
// vertical padding = 32px tall — measured live on macOS; the bundled font
// makes this the value on every OS.
expect(
  "global button ≈32px",
  close(report.probeButton?.h, 32, 1.5),
  `got ${report.probeButton?.h}`,
);
expect(
  "WCAG 2.5.8 ≥24px targets",
  (report.probeButton?.h ?? 0) >= 24 && (report.probeButton?.w ?? 0) >= 24,
  `got ${report.probeButton?.w}×${report.probeButton?.h}`,
);

// Per-platform chrome (R1 decisions).
if (report.platform === "mac") {
  expect("mac titlebar strip 44", close(report.titlebarStrip?.h, 44), `got ${report.titlebarStrip?.h}`);
  expect(
    "mac: no caption buttons",
    !report.winControls || report.winControls.w === 0,
    `got ${JSON.stringify(report.winControls)}`,
  );
} else {
  expect("titlebar strip 12", close(report.titlebarStrip?.h, 12), `got ${report.titlebarStrip?.h}`);
}
if (report.platform === "windows") {
  expect(
    "windows caption buttons 138×32",
    close(report.winControls?.w, 138) && close(report.winControls?.h, 32),
    `got ${JSON.stringify(report.winControls)}`,
  );
}
if (report.platform === "linux") {
  expect(
    "linux: no caption buttons",
    !report.winControls || report.winControls.w === 0,
    `got ${JSON.stringify(report.winControls)}`,
  );
}

// The gateway sidecar must have come up and answered /health.
expect("gateway sidecar /health ok", report.gateway?.ok === true, `got ${JSON.stringify(report.gateway)}`);

if (failures.length > 0) {
  console.error(`UI metrics FAILED (${report.platform}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}
console.log(`UI metrics OK (${report.platform}, dpr ${report.dpr}): ${JSON.stringify(report)}`);
