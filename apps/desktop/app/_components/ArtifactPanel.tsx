"use client";

import { useEffect, useState } from "react";
import { Layers, X, Copy, Download } from "lucide-react";
import {
  artifactExtension,
  artifactMime,
  type Artifact,
} from "@/lib/artifacts";
import { saveTextFile } from "@/lib/download";
import { CodeBlock, Markdown } from "./Markdown";

/** A filesystem-safe download name from the artifact's derived title. */
function downloadName(a: Artifact): string {
  const slug = a.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "artifact"}.${artifactExtension(a)}`;
}

function kindLabel(a: Artifact): string {
  if (a.kind === "html") return "HTML";
  if (a.kind === "svg") return "SVG";
  if (a.kind === "markdown") return "Document";
  return a.language ? a.language.toUpperCase() : "Code";
}

/**
 * Desktop artifacts workspace — a right-side drawer that lists the conversation's
 * artifacts and shows the selected one with Copy + Download.
 *
 * Unlike web, there is NO iframe preview: Tauri treats HTML differently and a
 * sandboxed iframe isn't the right model in the shell. So HTML/SVG/code are shown
 * as syntax-highlighted source (the same CodeBlock the chat uses) and a long
 * markdown doc is rendered through the shared Markdown renderer. Nothing here is
 * executed — the panel only displays the model's own output. Download writes
 * those exact bytes via the same mechanism as the chat's Export action.
 */
export function ArtifactPanel({
  artifacts,
  activeId,
  onSelect,
  onClose,
}: {
  artifacts: Artifact[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const active = artifacts.find((a) => a.id === activeId) ?? artifacts[0] ?? null;
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setCopied(false);
  }, [active?.id]);

  // Close on Escape — drawer convention.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function copy() {
    if (!active) return;
    try {
      await navigator.clipboard.writeText(active.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable — ignore */
    }
  }

  if (!active) return null;

  return (
    <div className="artifact-backdrop" onClick={onClose}>
      <aside
        className="artifact-panel"
        aria-label="Artifacts"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="artifact-panel-head">
          <span className="artifact-panel-title">
            <Layers size={14} /> Artifacts
          </span>
          <button
            type="button"
            className="artifact-panel-close"
            onClick={onClose}
            aria-label="Close artifacts panel"
          >
            <X size={14} />
          </button>
        </div>

        {artifacts.length > 1 ? (
          <div className="artifact-list" role="tablist" aria-label="Artifacts in this chat">
            {artifacts.map((a) => (
              <button
                key={a.id}
                type="button"
                role="tab"
                aria-selected={a.id === active.id}
                className={`artifact-list-item${a.id === active.id ? " active" : ""}`}
                onClick={() => onSelect(a.id)}
                title={a.title}
              >
                <span className="artifact-list-kind">{kindLabel(a)}</span>
                <span className="artifact-list-name">{a.title}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div className="artifact-toolbar">
          <span className="artifact-kind-chip" title={active.title}>
            {kindLabel(active)}
          </span>
          <div className="artifact-actions">
            <button type="button" className="artifact-action" onClick={() => void copy()}>
              <Copy size={12} />
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              className="artifact-action"
              onClick={() =>
                saveTextFile(downloadName(active), active.content, artifactMime(active))
              }
            >
              <Download size={12} />
              Download
            </button>
          </div>
        </div>

        <div className="artifact-body">
          {active.kind === "markdown" ? (
            <div className="artifact-doc">
              <Markdown content={active.content} />
            </div>
          ) : (
            <CodeBlock
              lang={active.language ?? ""}
              text={active.content}
              label={active.title}
            />
          )}
          <p className="artifact-panel-note">
            Shows this answer&apos;s own {kindLabel(active)} — nothing is executed.
          </p>
        </div>
      </aside>
    </div>
  );
}
