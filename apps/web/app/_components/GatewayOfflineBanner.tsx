"use client";

/**
 * Shown when the gateway `/health` check fails. The GUI is a thin client over
 * the gateway, so without it nothing routes — point the user at `zintus serve`.
 */
export function GatewayOfflineBanner({ url }: { url: string }) {
  return (
    <div
      role="status"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 8,
        padding: "8px 16px",
        fontSize: 13,
        background: "var(--color-surface)",
        color: "var(--color-text-sub)",
        // Calm hairline — the red status dot carries the alert; a full-width
        // saturated rule reads as alarm. Soften toward the neutral border.
        borderBottom: "1px solid color-mix(in oklch, var(--color-red) 40%, var(--color-border))",
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: "var(--color-red)",
        }}
      />
      <span>
        Gateway offline — run{" "}
        <code
          style={{
            padding: "1px 6px",
            borderRadius: 4,
            background: "var(--color-elevated)",
            color: "var(--color-text)",
          }}
        >
          zintus serve
        </code>{" "}
        then reload.
      </span>
      <span style={{ color: "var(--color-text-muted)" }}>
        Expecting it at {url}
      </span>
    </div>
  );
}
