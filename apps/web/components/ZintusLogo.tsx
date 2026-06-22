interface ZintusLogoProps {
  size?: "sm" | "md" | "lg";
  showWordmark?: boolean;
  className?: string;
}

const MARK_HEIGHT: Record<NonNullable<ZintusLogoProps["size"]>, number> = {
  sm: 24,
  md: 48,
  lg: 80,
};

const WORDMARK_SIZE: Record<NonNullable<ZintusLogoProps["size"]>, string> = {
  sm: "1rem",
  md: "1.6rem",
  lg: "2.4rem",
};

const GAP: Record<NonNullable<ZintusLogoProps["size"]>, string> = {
  sm: "0.5rem",
  md: "0.75rem",
  lg: "1rem",
};

export function ZintusLogo({ size = "md", showWordmark = false, className }: ZintusLogoProps) {
  const height = MARK_HEIGHT[size];

  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: GAP[size],
      }}
    >
      <svg
        width={height}
        height={height}
        viewBox="0 0 32 32"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="Zintus"
        style={{ flexShrink: 0 }}
      >
        {/* Top horizontal line (left -> right) */}
        <line x1="7" y1="8" x2="25" y2="8" stroke="var(--marketing-accent)" strokeWidth="2.4" strokeLinecap="round" />
        {/* Diagonal line (top-right -> bottom-left) */}
        <line x1="25" y1="8" x2="7" y2="24" stroke="var(--marketing-accent)" strokeWidth="2.4" strokeLinecap="round" />
        {/* Bottom horizontal line (left -> right) */}
        <line x1="7" y1="24" x2="25" y2="24" stroke="var(--marketing-accent)" strokeWidth="2.4" strokeLinecap="round" />

        {/* Dimmer midpoint nodes along the diagonal */}
        <circle cx="19.5" cy="13.3" r="1.4" fill="var(--marketing-accent-dim)" />
        <circle cx="12.5" cy="18.7" r="1.4" fill="var(--marketing-accent-dim)" />

        {/* Filled node endpoints (the four corners of the Z) */}
        <circle cx="7" cy="8" r="2.4" fill="var(--marketing-accent)" />
        <circle cx="25" cy="8" r="2.4" fill="var(--marketing-accent)" />
        <circle cx="7" cy="24" r="2.4" fill="var(--marketing-accent)" />
        <circle cx="25" cy="24" r="2.4" fill="var(--marketing-accent)" />
      </svg>
      {showWordmark ? (
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: WORDMARK_SIZE[size],
            color: "var(--marketing-text)",
            lineHeight: 1,
          }}
        >
          zintus
        </span>
      ) : null}
    </span>
  );
}
