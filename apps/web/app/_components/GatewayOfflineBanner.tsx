"use client";

import type { GatewayConnectionState } from "@/lib/gateway";

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
export function GatewayOfflineBanner({
  url,
  state,
}: {
  url: string;
  state: Exclude<GatewayConnectionState, "connected">;
}) {
  // Slim single-line strip (~36px): status dot + one honest line + links. The
  // full "point NEXT_PUBLIC_GATEWAY_URL elsewhere" detail moves to the title
  // tooltip so the strip stays one line. `url` is surfaced there.
  return (
    <div
      role="status"
      className={`app-offline-strip${state === "authentication-required" ? " app-offline-strip--auth" : ""}`}
      title={
        state === "authentication-required"
          ? `The gateway at ${url} is running but requires an operator token.`
          : state === "local-handshake-unavailable"
            ? `The gateway at ${url} is running, but its local secure handshake could not be completed.`
          : `Looking for the gateway at ${url} — set NEXT_PUBLIC_GATEWAY_URL to point elsewhere.`
      }
    >
      <span className="app-offline-dot" aria-hidden />
      {state === "authentication-required" ? (
        <>
          <span className="app-offline-text">
            <strong>Gateway authentication required.</strong> The gateway is
            running — enter its operator token to reconnect.
          </span>
          <span className="app-offline-links">
            <a href="/engineer#gateway-access">Enter token</a>
          </span>
        </>
      ) : state === "local-handshake-unavailable" ? (
        <>
          <span className="app-offline-text">
            <strong>Local authorization needs attention.</strong> Restart the local gateway and Zintus web app; no token copy is required.
          </span>
          <span className="app-offline-links"><a href="/engineer#gateway-access">Troubleshoot</a></span>
        </>
      ) : (
        <>
          <span className="app-offline-text">
            <strong>No gateway connected.</strong> Zintus is local-first — start it
            with <code>zintus serve</code>.
          </span>
          <span className="app-offline-links">
            <a href="/docs#self-host">Self-host</a>
            <a href="/download">Download</a>
          </span>
        </>
      )}
    </div>
  );
}
