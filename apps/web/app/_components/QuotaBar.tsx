export function QuotaBar({
  value,
  color,
  thin = false,
}: {
  value: number;
  color: string;
  thin?: boolean;
}) {
  const pct = Math.max(0, Math.min(100, value));

  return (
    <div className={`quota-track${thin ? " thin" : ""}`}>
      <div
        className="quota-fill"
        style={{
          width: `${pct}%`,
          background:
            pct > 50
              ? color
              : pct > 20
                ? "var(--c-accent)"
                : pct > 10
                  ? "var(--c-warn)"
                  : "var(--c-danger)",
        }}
      />
    </div>
  );
}
