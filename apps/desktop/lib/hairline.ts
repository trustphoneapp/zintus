/**
 * Hairline width management: `--hairline` on <html> is exactly one device
 * pixel (1/devicePixelRatio CSS px) so button/card edges rasterize crisp on
 * every display — 0.5px on Retina, 1px at 100%, 0.8px at Windows 125%,
 * 0.6667px at 150%, 0.5714px at 175% (R2 decision, docs/launch/research/).
 * globals.css keeps a 2-bucket media-query fallback for the pre-JS first
 * frame; this module overrides it immediately and re-applies when the window
 * moves to a monitor with a different scale factor.
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

/**
 * Inline pre-hydration script (layout.tsx <head>): sets the device-pixel
 * hairline before first paint, then keeps it correct across monitor changes.
 * Same contract as THEME_INIT_SCRIPT — dependency-free and tiny. Kept as a
 * string mirror of applyHairline/watchHairline above (unit test pins them
 * together).
 */
export const HAIRLINE_INIT_SCRIPT = `(function(){try{var a=function(){var d=window.devicePixelRatio||1;document.documentElement.style.setProperty("--hairline",Math.round(10000/d)/10000+"px")};var w=function(){var d=window.devicePixelRatio||1;var m=matchMedia("(resolution: "+d+"dppx)");var h=function(){a();w()};m.addEventListener("change",h,{once:true})};a();w()}catch(e){}})();`;
