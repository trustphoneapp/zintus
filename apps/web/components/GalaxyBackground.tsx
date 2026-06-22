"use client";

interface Star {
  x: number;
  y: number;
  size: number;
  opacity: number;
  violet?: boolean;
}

// Deterministic pseudo-random generator (mulberry32) seeded with a fixed
// constant so star positions are stable across server/client renders and
// don't cause hydration mismatches.
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

function generateStars(): Star[] {
  const rand = mulberry32(1337);
  const stars: Star[] = [];
  const total = 56;
  const violetCount = 8;

  for (let i = 0; i < total; i++) {
    // Concentrate stars toward the edges, sparse near the center where
    // hero text/content sits: bias the radius away from the middle.
    const angle = rand() * Math.PI * 2;
    const edgeBias = 0.35 + rand() * 0.65; // 0.35..1.0 of the way to the edge
    const radius = edgeBias * 60; // up to 60% from center
    const x = 50 + Math.cos(angle) * radius * (0.9 + rand() * 0.3);
    const y = 50 + Math.sin(angle) * radius * (0.9 + rand() * 0.3);

    stars.push({
      x: Math.max(2, Math.min(98, x)),
      y: Math.max(2, Math.min(98, y)),
      size: 1 + Math.round(rand()),
      opacity: 0.2 + rand() * 0.15,
      violet: i < violetCount,
    });
  }

  return stars;
}

const STARS = generateStars();

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
        background: "var(--marketing-bg)",
      }}
    >
      {/* Large central radial violet glow, low opacity */}
      <div
        style={{
          position: "absolute",
          top: "-10%",
          left: "50%",
          width: "1400px",
          height: "1400px",
          transform: "translateX(-50%)",
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(124, 58, 237, 0.14) 0%, rgba(124, 58, 237, 0.06) 40%, transparent 70%)",
        }}
      />
      {/* Smaller, brighter inner glow */}
      <div
        style={{
          position: "absolute",
          top: "8%",
          left: "50%",
          width: "560px",
          height: "560px",
          transform: "translateX(-50%)",
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(167, 139, 250, 0.16) 0%, transparent 72%)",
        }}
      />
      {/* Star field */}
      {STARS.map((star, i) => (
        <span
          key={i}
          style={{
            position: "absolute",
            left: `${star.x}%`,
            top: `${star.y}%`,
            width: `${star.size}px`,
            height: `${star.size}px`,
            borderRadius: "50%",
            background: star.violet ? "var(--marketing-accent-light)" : "#ffffff",
            opacity: star.opacity,
          }}
        />
      ))}
    </div>
  );
}
