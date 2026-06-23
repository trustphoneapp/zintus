"use client";

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Star { x: number; y: number; size: number; opacity: number; violet?: boolean; }

function generateStars(): Star[] {
  const rand = mulberry32(42);
  return Array.from({ length: 80 }, (_, i) => {
    const angle = rand() * Math.PI * 2;
    const edgeBias = 0.3 + rand() * 0.7;
    const radius = edgeBias * 65;
    const x = Math.max(1, Math.min(99, 50 + Math.cos(angle) * radius * (0.8 + rand() * 0.4)));
    const y = Math.max(1, Math.min(99, 50 + Math.sin(angle) * radius * (0.8 + rand() * 0.4)));
    return { x, y, size: rand() > 0.7 ? 2 : 1, opacity: 0.15 + rand() * 0.2, violet: i < 12 };
  });
}

const STARS = generateStars();

export function GalaxyBackground() {
  return (
    <div aria-hidden="true" style={{ position: "fixed", inset: 0, zIndex: -1, pointerEvents: "none", overflow: "hidden", background: "#07040f" }}>
      {/* Deep outer glow */}
      <div style={{ position: "absolute", top: "-20%", left: "50%", width: "1600px", height: "1600px", transform: "translateX(-50%)", borderRadius: "50%", background: "radial-gradient(circle, rgba(91,33,182,0.18) 0%, rgba(91,33,182,0.07) 35%, transparent 65%)" }} />
      {/* Mid glow */}
      <div style={{ position: "absolute", top: "5%", left: "50%", width: "800px", height: "800px", transform: "translateX(-50%)", borderRadius: "50%", background: "radial-gradient(circle, rgba(124,58,237,0.14) 0%, rgba(124,58,237,0.04) 50%, transparent 75%)" }} />
      {/* Top beam — subtle diagonal */}
      <div style={{ position: "absolute", top: "-10%", left: "30%", width: "600px", height: "400px", background: "radial-gradient(ellipse, rgba(124,58,237,0.08) 0%, transparent 70%)", transform: "rotate(-25deg)", borderRadius: "50%" }} />
      {/* Bottom-right accent */}
      <div style={{ position: "absolute", bottom: "-5%", right: "10%", width: "500px", height: "400px", background: "radial-gradient(ellipse, rgba(76,29,149,0.1) 0%, transparent 70%)", borderRadius: "50%" }} />
      {STARS.map((star, i) => (
        <span key={i} style={{ position: "absolute", left: `${star.x}%`, top: `${star.y}%`, width: `${star.size}px`, height: `${star.size}px`, borderRadius: "50%", background: star.violet ? "#a78bfa" : "#ffffff", opacity: star.opacity }} />
      ))}
    </div>
  );
}
