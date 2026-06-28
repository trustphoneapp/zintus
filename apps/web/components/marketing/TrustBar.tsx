import { Zap, KeyRound, ShieldCheck, Wrench, Star } from "lucide-react";

const ITEMS = [
  { icon: Zap, label: "< 5ms routing latency" },
  { icon: KeyRound, label: "12 free AI providers" },
  { icon: ShieldCheck, label: "Keys never leave your device" },
  { icon: Wrench, label: "Tools · JSON · image input" },
  { icon: Star, label: "BUSL-1.1 source-available" },
];

export function TrustBar() {
  return (
    <section
      style={{
        borderTop: "1px solid rgba(124,58,237,0.12)",
        borderBottom: "1px solid rgba(124,58,237,0.12)",
        background: "rgba(7,4,15,0.6)",
      }}
    >
      <div className="m-shell">
        <ul className="trust-bar">
          {ITEMS.map(({ icon: Icon, label }) => (
            <li key={label} className="trust-bar-item">
              <Icon size={14} color="#a78bfa" />
              <span>{label}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
