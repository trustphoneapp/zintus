/**
 * In-artifact LLM bridge — protocol + authorization. Pure, DOM-free, unit-tested.
 *
 * This is the no-custody version of Claude's `window.claude.complete`: an artifact
 * running in the sandboxed preview can ask the router to complete a prompt, but
 * the BYOK key never enters the frame — the call is made host-side and the result
 * is posted back. Because the frame is `sandbox="allow-scripts"` with NO
 * `allow-same-origin`, it runs at an opaque/null origin, so `event.origin` is the
 * useless string "null". We therefore authenticate a message by SOURCE IDENTITY
 * (`event.source === iframe.contentWindow`), not origin, and gate every call
 * through the per-artifact quota + consent (see lib/artifact-quota).
 *
 * This module is the testable core: the wire protocol, the injected shim, and the
 * host-side authorization decision. It deliberately does NOT attach to a live
 * iframe or call the gateway — that integration is opt-in and security-reviewed
 * (a runtime token-spend surface), and stays off until then.
 */

import {
  decideSpend,
  type ArtifactBudget,
  type ArtifactConsent,
  type SpendDecision,
} from "./artifact-quota";

export interface BridgeRequest {
  type: "zintus:complete";
  /** Correlation id the host echoes back on the reply. */
  id: string;
  prompt: string;
}

export interface BridgeResponse {
  type: "zintus:complete:result";
  id: string;
  ok: boolean;
  text?: string;
  error?: string;
}

/** Narrow an untrusted postMessage payload to a well-formed bridge request. */
export function isBridgeRequest(data: unknown): data is BridgeRequest {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    d.type === "zintus:complete" &&
    typeof d.id === "string" &&
    d.id.length > 0 &&
    typeof d.prompt === "string"
  );
}

/** Build a host→frame reply. */
export function bridgeReply(id: string, result: { text: string } | { error: string }): BridgeResponse {
  return "text" in result
    ? { type: "zintus:complete:result", id, ok: true, text: result.text }
    : { type: "zintus:complete:result", id, ok: false, error: result.error };
}

/**
 * The `<script>` injected into the artifact's `srcDoc`. Gives the artifact
 * `window.zintus.complete(prompt) → Promise<string>` that posts a request to the
 * parent and resolves on the matching reply. No key, no network, no origin — just
 * a message to the host, which decides and (if allowed) runs the call. `'*'` is a
 * safe `targetOrigin` here because the payload is a prompt, never a secret, and
 * the host authenticates the reverse direction by source identity.
 */
export function bridgeShim(): string {
  return [
    "<script>(function(){",
    "var pending={};",
    "window.addEventListener('message',function(e){",
    "var m=e.data; if(!m||m.type!=='zintus:complete:result')return;",
    "var p=pending[m.id]; if(!p)return; delete pending[m.id];",
    "if(m.ok)p.resolve(m.text); else p.reject(new Error(m.error||'denied'));",
    "});",
    "window.zintus={complete:function(prompt){return new Promise(function(resolve,reject){",
    "var id='b'+Math.random().toString(36).slice(2);",
    "pending[id]={resolve:resolve,reject:reject};",
    "parent.postMessage({type:'zintus:complete',id:id,prompt:String(prompt)},'*');",
    "});}};",
    "})();<\/script>",
  ].join("");
}

export type BridgeAuth =
  | { ok: true; needsConfirm: boolean }
  | { ok: false; reason: "untrusted-source" | SpendDecisionReason };

type SpendDecisionReason = Exclude<SpendDecision, { allow: true }>["reason"];

/**
 * Authorize ONE bridge call, host-side. First proves the message came from the
 * artifact's own frame (identity, since the origin is opaque), then gates the
 * estimated spend through the quota + consent. Pure decision — the caller runs
 * the gateway call only on `{ ok: true }` and must still honour `needsConfirm`.
 */
export function authorizeBridgeCall(opts: {
  /** `event.source` from the message event. */
  source: unknown;
  /** The artifact iframe's `contentWindow`. */
  frame: unknown;
  budget: ArtifactBudget;
  consent: ArtifactConsent;
  estUsd: number;
  rateLimit?: number;
  rateWindowMs?: number;
  now?: number;
}): BridgeAuth {
  // The one trustworthy signal under no-same-origin: it's literally our frame.
  if (opts.source == null || opts.source !== opts.frame) {
    return { ok: false, reason: "untrusted-source" };
  }
  // Runtime calls ALWAYS require consent (unlike a user-clicked re-bake).
  const decision = decideSpend(opts.budget, opts.consent, opts.estUsd, {
    requireConsent: true,
    rateLimit: opts.rateLimit,
    rateWindowMs: opts.rateWindowMs,
    now: opts.now,
  });
  if (!decision.allow) return { ok: false, reason: decision.reason };
  return { ok: true, needsConfirm: decision.needsConfirm };
}
