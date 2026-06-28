"use client";

import { useEffect, useState } from "react";
import { downloadFile } from "@/lib/download";
import {
  artifactExtension,
  artifactMime,
  type Artifact,
} from "@/lib/artifacts";
import { CodeBlock, Markdown } from "./Markdown";
import { Icon } from "./Icons";

/** Tabs are only meaningful for renderable artifacts (HTML / SVG). */
function canPreview(a: Artifact): boolean {
  return a.kind === "html" || a.kind === "svg";
}

/** Wrap a bare SVG so the sandboxed frame centres it on a calm background. */
function svgPreviewDoc(svg: string): string {
  return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;background:#0a0e13}</style>${svg}`;
}

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
 * Right-side artifacts workspace. Lists the conversation's artifacts and shows
 * the selected one with Copy + Download, and — for HTML/SVG — a Preview that
 * renders the model's OWN output inside a sandboxed iframe.
 *
 * Sandbox: `sandbox="allow-scripts"` with NO `allow-same-origin`, so scripts in
 * the model's HTML run in an opaque origin — they can't reach this page, your
 * cookies, or storage. `srcDoc` keeps it self-contained (no network fetch).
 * If the browser's CSP blocks the frame, the Preview degrades to the code with
 * an honest note rather than breaking the page.
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
  // "preview" | "code" — default to preview for renderable kinds.
  const [tab, setTab] = useState<"preview" | "code">("code");
  const [copied, setCopied] = useState(false);
  const [previewBlocked, setPreviewBlocked] = useState(false);

  // Reset the view when the selected artifact changes.
  useEffect(() => {
    setPreviewBlocked(false);
    setTab(active && canPreview(active) ? "preview" : "code");
  }, [active?.id]);

  async function copy() {
    if (!active) return;
    try {
      await navigator.clipboard.writeText(active.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable (insecure context) — ignore */
    }
  }

  if (!active) return null;

  const showPreview = canPreview(active) && tab === "preview" && !previewBlocked;

  return (
    <aside className="artifact-panel" aria-label="Artifacts">
      <div className="artifact-panel-head">
        <span className="artifact-panel-title">
          <Icon name="layers" size={14} /> Artifacts
        </span>
        <button
          type="button"
          className="artifact-panel-close"
          onClick={onClose}
          aria-label="Close artifacts panel"
        >
          <Icon name="x" size={14} />
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
        <div className="artifact-tabs">
          {canPreview(active) ? (
            <>
              <button
                type="button"
                className={`artifact-tab${tab === "preview" ? " active" : ""}`}
                onClick={() => setTab("preview")}
                aria-pressed={tab === "preview"}
              >
                Preview
              </button>
              <button
                type="button"
                className={`artifact-tab${tab === "code" ? " active" : ""}`}
                onClick={() => setTab("code")}
                aria-pressed={tab === "code"}
              >
                Code
              </button>
            </>
          ) : (
            <span className="artifact-kind-chip">{kindLabel(active)}</span>
          )}
        </div>
        <div className="artifact-actions">
          <button type="button" className="artifact-action" onClick={() => void copy()}>
            <Icon name="copy" size={12} />
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            className="artifact-action"
            onClick={() =>
              downloadFile(downloadName(active), active.content, artifactMime(active))
            }
          >
            <Icon name="paperclip" size={12} />
            Download
          </button>
        </div>
      </div>

      <div className="artifact-body">
        {showPreview ? (
          <div className="artifact-preview">
            <iframe
              title={`Preview of ${active.title}`}
              className="artifact-preview-frame"
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              srcDoc={
                active.kind === "svg" ? svgPreviewDoc(active.content) : active.content
              }
              onError={() => setPreviewBlocked(true)}
            />
            <p className="artifact-preview-note">
              Renders this answer's own {kindLabel(active)} in a sandboxed frame — no
              network, no access to this page.
            </p>
          </div>
        ) : active.kind === "markdown" ? (
          <div className="artifact-doc">
            <Markdown content={active.content} />
          </div>
        ) : (
          <>
            {previewBlocked ? (
              <p className="artifact-preview-note artifact-preview-blocked">
                Preview unavailable in this browser — showing the code instead.
              </p>
            ) : null}
            <CodeBlock
              lang={active.language ?? ""}
              text={active.content}
              label={active.title}
            />
          </>
        )}
      </div>
    </aside>
  );
}
