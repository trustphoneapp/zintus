/**
 * Hairline width management: `--hairline` on <html> is exactly one device
 * pixel (1/devicePixelRatio CSS px) so button/card edges rasterize crisp on
 * every display — 0.5px on Retina, 1px at 100%, 0.8px at Windows 125%,
 * 0.6667px at 150%, 0.5714px at 175% (R2 decision, docs/launch/research/).
 * globals.css keeps a 2-bucket media-query fallback for the pre-JS first
 * frames; lib/boot.ts applies this module before hydration paints and
 * re-applies when the window moves to a monitor with a different scale
 * factor.
 */

/** One device pixel in CSS px for a given devicePixelRatio, 4-decimal fixed. */
export function hairlineCssPx(dpr: number): string {
  const safe = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return `${Math.round(10000 / safe) / 10000}px`;
}

export function applyHairline(): void {
  if (typeof document === "undefined") return;
  const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
  document.documentElement.style.setProperty("--hairline", hairlineCssPx(dpr));
}

/**
 * Re-apply on scale-factor change (monitor move / user rescaling). The
 * standard pattern: a one-shot matchMedia on the *current* dppx fires when it
 * stops matching; re-subscribe after each change.
 */
export function watchHairline(): () => void {
  if (typeof matchMedia === "undefined") return () => {};
  let mq: MediaQueryList | null = null;
  let disposed = false;
  const subscribe = () => {
    if (disposed) return;
    const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    mq = matchMedia(`(resolution: ${dpr}dppx)`);
    mq.addEventListener("change", onChange, { once: true });
  };
  const onChange = () => {
    applyHairline();
    subscribe();
  };
  subscribe();
  return () => {
    disposed = true;
    mq?.removeEventListener("change", onChange);
  };
}

