"use client";

export function QuotaBar({
  used,
  limit,
  label,
}: {
  used: number;
  limit: number;
  label?: string;
}) {
  const pct = limit > 0 ? Math.min(used / limit, 1) : 0;
  // Usage framing (pct = fraction used). --color-yellow was undefined on desktop
  // — use the shared design-system thresholds.
  const color =
    pct >= 0.9
      ? "var(--c-danger)"
      : pct >= 0.7
        ? "var(--c-warn)"
        : "var(--c-ok)";

  return (
    <div>
      {label && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 12,
            color: "var(--color-text-sub)",
            marginBottom: 4,
          }}
        >
          <span>{label}</span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
            {Math.round(pct * 100)}%
          </span>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div
          style={{
            flex: 1,
            height: 6,
            background: "var(--color-border)",
            borderRadius: 999,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${pct * 100}%`,
              height: "100%",
              background: color,
              borderRadius: 999,
            }}
          />
        </div>
        {!label && (
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color,
              minWidth: 72,
              textAlign: "right",
            }}
          >
            {Math.round(pct * 100)}%
          </span>
        )}
      </div>
    </div>
  );
}
