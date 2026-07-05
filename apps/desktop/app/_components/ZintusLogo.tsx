/**
 * The Zintus "Z constellation" mark — ported from the web UI
 * (apps/web/components/ZintusLogo.tsx) so every surface wears the same logo
 * instead of the old ArrowRight placeholder. Colors map the marketing vars to
 * the desktop token set (accent + dim nodes follow the active theme).
 */
export function ZintusLogo({ size = 26 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Zintus"
      style={{ flexShrink: 0 }}
    >
      <line x1="7" y1="8" x2="25" y2="8" stroke="var(--c-accent)" strokeWidth="2.4" strokeLinecap="round" />
      <line x1="25" y1="8" x2="7" y2="24" stroke="var(--c-accent)" strokeWidth="2.4" strokeLinecap="round" />
      <line x1="7" y1="24" x2="25" y2="24" stroke="var(--c-accent)" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="19.5" cy="13.3" r="1.4" fill="var(--c-accent-mid)" />
      <circle cx="12.5" cy="18.7" r="1.4" fill="var(--c-accent-mid)" />
      <circle cx="7" cy="8" r="2.4" fill="var(--c-accent)" />
      <circle cx="25" cy="8" r="2.4" fill="var(--c-accent)" />
      <circle cx="7" cy="24" r="2.4" fill="var(--c-accent)" />
      <circle cx="25" cy="24" r="2.4" fill="var(--c-accent)" />
    </svg>
  );
}
