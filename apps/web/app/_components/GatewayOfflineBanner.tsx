"use client";

/**
 * Shown when the gateway `/v1/status` check fails. The web UI is a thin client
 * over the gateway, so without it nothing routes.
 *
 * Zintus is local-first / BYOK: the user runs the gateway themselves and their
 * provider keys stay on their device — there is no hosted gateway to fall back
 * to. So this is framed as an onboarding step (start the daemon), not a dev
 * error. Copy points at the real end-user path (`zintus serve`) and the
 * self-host docs / download funnel — never internal dev commands.
 */
export function GatewayOfflineBanner({ url }: { url: string }) {
  return (
    <div
      role="status"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 10,
        padding: "10px 16px",
        fontSize: 13,
        lineHeight: 1.5,
        background: "var(--color-surface)",
        color: "var(--color-text-sub)",
        // Calm hairline — the status dot carries the alert; a full-width
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
          flexShrink: 0,
        }}
      />
      <span>
        <strong style={{ color: "var(--color-text)" }}>
          No gateway connected.
        </strong>{" "}
        Zintus is local-first — you run the gateway and your keys stay on your
        device. Start it with{" "}
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
      <span style={{ display: "inline-flex", gap: 12, marginLeft: "auto" }}>
        <a href="/docs#self-host" style={{ color: "var(--color-accent)" }}>
          Self-host guide →
        </a>
        <a href="/download" style={{ color: "var(--color-accent)" }}>
          Download
        </a>
      </span>
      <span
        style={{
          flexBasis: "100%",
          color: "var(--color-text-muted)",
          fontSize: 12,
        }}
      >
        Looking for the gateway at {url} — point{" "}
        <code
          style={{
            padding: "0 4px",
            borderRadius: 3,
            background: "var(--color-elevated)",
          }}
        >
          NEXT_PUBLIC_GATEWAY_URL
        </code>{" "}
        elsewhere if it runs on another host.
      </span>
    </div>
  );
}
