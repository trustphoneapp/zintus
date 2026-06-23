// Server component — no "use client". Stars are generated deterministically
// at module init time so there are zero hydration mismatches.

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Star {
  x: number;
  y: number;
  r: number;
  opacity: number;
  violet: boolean;
}

function buildStars(): Star[] {
  const rand = mulberry32(0xdeadbeef);
  const stars: Star[] = [];

  for (let i = 0; i < 60; i++) {
    const angle = rand() * Math.PI * 2;
    // 70% outer zone (55–95% from center), 30% middle zone (33–55%)
    const outer = rand() < 0.7;
    const r = outer ? 0.55 + rand() * 0.40 : 0.33 + rand() * 0.22;
    const x = 50 + Math.cos(angle) * r * 50;
    const y = 50 + Math.sin(angle) * r * 50;

    stars.push({
      x: Math.max(2, Math.min(98, x)),
      y: Math.max(2, Math.min(98, y)),
      // diameter 0.5–1.2px → radius 0.25–0.6
      r: 0.25 + rand() * 0.35,
      opacity: 0.20 + rand() * 0.15,
      // first 5 are violet-tinted, rest white
      violet: i < 5,
    });
  }

  return stars;
}

const STARS = buildStars();

export function GalaxyBackground() {
  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: -1,
        pointerEvents: "none",
        overflow: "hidden",
        background: "#07040f",
      }}
    >
      <svg
        width="100%"
        height="100%"
        style={{ display: "block" }}
        preserveAspectRatio="none"
      >
        <defs>
          {/*
            objectBoundingBox (default): cx/cy/r are fractions of the element's
            bounding box. r="0.5" = extends to 50% of each side from center.
            On a landscape viewport the gradient is slightly elliptical —
            imperceptible at these low opacities.
          */}
          <radialGradient id="zintus-glow-outer" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor="#2e0057" stopOpacity="0.15" />
            <stop offset="65%" stopColor="#2e0057" stopOpacity="0.04" />
            <stop offset="100%" stopColor="#2e0057" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="zintus-glow-inner" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor="#4a0080" stopOpacity="0.10" />
            <stop offset="55%" stopColor="#4a0080" stopOpacity="0.02" />
            <stop offset="100%" stopColor="#4a0080" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Large outer glow — spans the full viewport */}
        <rect
          width="100%"
          height="100%"
          fill="url(#zintus-glow-outer)"
        />

        {/* Inner glow — tighter, centered on the upper third (hero area) */}
        <rect
          x="22%"
          y="5%"
          width="56%"
          height="52%"
          fill="url(#zintus-glow-inner)"
        />

        {/* Star field — 60 dots, edge-concentrated */}
        {STARS.map((star, i) => (
          <circle
            key={i}
            cx={`${star.x}%`}
            cy={`${star.y}%`}
            r={star.r}
            fill={star.violet ? "#c4b5fd" : "#ffffff"}
            fillOpacity={star.opacity}
          />
        ))}
      </svg>
    </div>
  );
}
