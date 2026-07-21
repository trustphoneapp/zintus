"use client";

import { useState } from "react";
import { PremiumPreviewAccess } from "@/app/judge/JudgeLiveAccess";
import { createPortal } from "react-dom";

const LOCAL_SETUP_COMMAND = `# From your Zintus checkout\ncd /path/to/zintus\nbun install\nbun run dev:gateway`;

function LocalSetupModal({ onClose }: { onClose: () => void }) {
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const copySetup = async () => {
    try { await navigator.clipboard.writeText(LOCAL_SETUP_COMMAND); setCopyStatus("Copied"); }
    catch { setCopyStatus("Copy failed — select the command and copy it manually."); }
  };
  const content = <div className="engineer-local-setup-modal" role="dialog" aria-modal="true" aria-labelledby="local-setup-title" onMouseDown={onClose}><section onMouseDown={(event) => event.stopPropagation()}><header><div><span className="engineer-kicker">Optional local workspace</span><h2 id="local-setup-title">Connect Zintus on this computer</h2></div><button type="button" aria-label="Close setup instructions" onClick={onClose}>×</button></header><p>Run this once from your Zintus project folder. Keep the terminal open while Engineer works, then return to Zintus and connect your local workspace.</p><div className="engineer-terminal-instructions"><div><span>Terminal</span><button type="button" onClick={() => void copySetup()}>{copyStatus ?? "Copy"}</button></div><pre><code>{LOCAL_SETUP_COMMAND}</code></pre></div><ol><li>Paste the command into Terminal and press Enter.</li><li>Wait for the gateway to start.</li><li>Return to Engineer and choose your local workspace.</li></ol><footer><button type="button" className="engineer-online-primary" onClick={onClose}>Done</button></footer></section></div>;
  return typeof document === "undefined" ? null : createPortal(content, document.body);
}

export function OnlineEngineerControls({ onlineAccessConfigured }: { onlineAccessConfigured: boolean }) {
  const [request, setRequest] = useState("");
  const [showInstructions, setShowInstructions] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const continueLocally = () => {
    if (!request.trim()) { setMessage("Describe the task first, then continue to the real local Engineer workspace."); return; }
    window.sessionStorage.setItem("zintus-engineer-prefill-request", request.trim());
    window.location.assign("/engineer");
  };

  return <>
    <div className="engineer-online-task-preview">
      <label>What should Zintus Engineer do?<textarea rows={5} value={request} onChange={(event) => { setRequest(event.target.value); setMessage(null); }} placeholder="Example: Add a secure webhook signature verifier with unit tests and no new dependencies." /></label>
      <aside><span className="engineer-kicker">Bounded before execution</span><strong>Scope · tests · budget</strong><p>Nothing runs until the plan is reviewed and frozen.</p></aside>
    </div>
    {message ? <p className="engineer-online-form-message" role="status">{message}</p> : null}
    <div className="engineer-online-task-actions"><button type="button" className="engineer-online-primary" onClick={() => document.getElementById("online-start")?.scrollIntoView({ behavior: "smooth", block: "center" })}>Continue to secure access ↓</button><button type="button" className="engineer-online-secondary" onClick={() => setShowInstructions(true)}>Local setup instructions</button></div>
    <section className="engineer-online-access" id="online-start">
      <div><span className="engineer-kicker">Start the real Engineer workflow</span><h2>{onlineAccessConfigured ? "OpenAI access enabled by Zintus." : "Continue with your local Zintus Engineer."}</h2><p>{onlineAccessConfigured ? "Activate your protected online session. Your browser never receives the OpenAI key and local setup is not required." : "This opens the existing Engineer workspace on this computer with your task already filled in. Start the local gateway first if it is not connected."}</p></div>
      {onlineAccessConfigured ? <PremiumPreviewAccess pendingRequest={request} /> : <div className="engineer-online-start-actions"><button type="button" className="engineer-premium-preview-link" onClick={continueLocally}>Open real Engineer <span aria-hidden="true">→</span></button><button type="button" className="engineer-online-text-button" onClick={() => setShowInstructions(true)}>How to connect locally</button></div>}
    </section>
    {showInstructions ? <LocalSetupModal onClose={() => setShowInstructions(false)} /> : null}
  </>;
}

export function LocalWorkspaceInstructionsButton() {
  const [open, setOpen] = useState(false);
  return <><button type="button" className="engineer-local-instructions-button" onClick={() => setOpen(true)}>View instructions</button>{open ? <LocalSetupModal onClose={() => setOpen(false)} /> : null}</>;
}
