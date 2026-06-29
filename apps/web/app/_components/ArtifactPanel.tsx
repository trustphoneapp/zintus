"use client";

import { useEffect, useMemo, useState } from "react";
import { downloadFile } from "@/lib/download";
import {
  artifactExtension,
  artifactMime,
  type Artifact,
  type ArtifactVersion,
  type VersionedArtifact,
} from "@/lib/artifacts";
import { CodeBlock, Markdown } from "./Markdown";
import { Icon } from "./Icons";

/** Tabs are only meaningful for renderable artifacts (HTML / SVG). */
function canPreview(a: { kind: Artifact["kind"] }): boolean {
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

function kindLabel(a: { kind: Artifact["kind"]; language?: string }): string {
  if (a.kind === "html") return "HTML";
  if (a.kind === "svg") return "SVG";
  if (a.kind === "markdown") return "Document";
  return a.language ? a.language.toUpperCase() : "Code";
}

/** Every version of an artifact: the model's, then any local user edits. */
function allVersionsOf(
  a: VersionedArtifact,
  userVersions: Record<string, ArtifactVersion[]>,
): ArtifactVersion[] {
  return [...a.versions, ...(userVersions[a.id] ?? [])];
}

/**
 * Right-side artifacts workspace — now ITERATIVE.
 *
 * Lists the conversation's artifacts (one entry per identity, re-emitted bodies
 * folded into versions). For the selected artifact it shows Copy + Download, a
 * version switcher ("vN of M" + prev/next), an Edit affordance that saves a
 * local "user-edit" version, and — for HTML/SVG — a Preview that renders the
 * selected version inside a sandboxed iframe.
 *
 * Sandbox: `sandbox="allow-scripts"` with NO `allow-same-origin`, so scripts in
 * the model's HTML run in an opaque origin — they can't reach this page, your
 * cookies, or storage. `srcDoc` keeps it self-contained (no network fetch).
 * Edits live only in this component's state — no server round-trip.
 */
export function ArtifactPanel({
  artifacts,
  activeId,
  onSelect,
  onClose,
}: {
  artifacts: VersionedArtifact[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  // activeId may be a folded artifact id (from the list) or a per-message source
  // id (from an inline "open in panel" link) — resolve both.
  const active =
    artifacts.find((a) => a.id === activeId) ??
    artifacts.find((a) => a.versions.some((v) => v.sourceId === activeId)) ??
    artifacts[0] ??
    null;

  const [tab, setTab] = useState<"preview" | "code">("code");
  const [copied, setCopied] = useState(false);
  const [previewBlocked, setPreviewBlocked] = useState(false);
  // Local, in-memory edit history per artifact — no server needed.
  const [userVersions, setUserVersions] = useState<Record<string, ArtifactVersion[]>>({});
  // Which version is shown, per artifact id (defaults to the latest).
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const versions = useMemo(
    () => (active ? allVersionsOf(active, userVersions) : []),
    [active, userVersions],
  );
  const lastIndex = versions.length - 1;
  const sel = active
    ? Math.min(selected[active.id] ?? lastIndex, lastIndex)
    : 0;
  const shownVersion = versions[sel] ?? null;
  const shown: Artifact | null =
    active && shownVersion
      ? {
          id: active.id,
          kind: shownVersion.kind,
          language: shownVersion.language,
          title: shownVersion.title,
          content: shownVersion.content,
        }
      : null;

  // Reset the view when the selected artifact changes.
  useEffect(() => {
    setPreviewBlocked(false);
    setEditing(false);
    setTab(active && canPreview(active) ? "preview" : "code");
  }, [active?.id]);

  async function copy() {
    if (!shown) return;
    try {
      await navigator.clipboard.writeText(shown.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable (insecure context) — ignore */
    }
  }

  function setVersion(i: number) {
    if (!active) return;
    setSelected((prev) => ({ ...prev, [active.id]: Math.max(0, Math.min(i, lastIndex)) }));
    setEditing(false);
    setPreviewBlocked(false);
  }

  function startEditing() {
    if (!shown) return;
    setDraft(shown.content);
    setEditing(true);
  }

  function saveVersion() {
    if (!active || !shown) return;
    // No-op if nothing changed vs the version we started from — don't bloat history.
    if (draft === shown.content) {
      setEditing(false);
      return;
    }
    const v: ArtifactVersion = {
      content: draft,
      kind: active.kind,
      language: active.language,
      title: active.title,
      label: `v${versions.length + 1}`,
      source: "user-edit",
      createdAt: Date.now(),
    };
    const newIndex = versions.length; // appended at the end
    setUserVersions((prev) => ({ ...prev, [active.id]: [...(prev[active.id] ?? []), v] }));
    setSelected((prev) => ({ ...prev, [active.id]: newIndex }));
    setEditing(false);
    setPreviewBlocked(false);
  }

  if (!active || !shown || !shownVersion) return null;

  const showPreview = canPreview(shown) && tab === "preview" && !previewBlocked && !editing;

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

      {versions.length > 1 ? (
        <div className="artifact-versions" role="group" aria-label="Version history">
          <button
            type="button"
            className="artifact-version-nav"
            onClick={() => setVersion(sel - 1)}
            disabled={sel <= 0}
            aria-label="Previous version"
          >
            ‹
          </button>
          <span className="artifact-version-label">
            v{sel + 1} of {versions.length}
            <span className={`artifact-version-source artifact-version-source-${shownVersion.source}`}>
              {shownVersion.source === "user-edit" ? "your edit" : "model"}
            </span>
          </span>
          <button
            type="button"
            className="artifact-version-nav"
            onClick={() => setVersion(sel + 1)}
            disabled={sel >= lastIndex}
            aria-label="Next version"
          >
            ›
          </button>
        </div>
      ) : null}

      <div className="artifact-toolbar">
        <div className="artifact-tabs">
          {canPreview(shown) && !editing ? (
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
            <span className="artifact-kind-chip">{kindLabel(shown)}</span>
          )}
        </div>
        <div className="artifact-actions">
          {editing ? (
            <>
              <button type="button" className="artifact-action" onClick={saveVersion}>
                <Icon name="check" size={12} />
                Save as new version
              </button>
              <button
                type="button"
                className="artifact-action"
                onClick={() => setEditing(false)}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button type="button" className="artifact-action" onClick={startEditing}>
                <Icon name="pencil" size={12} />
                Edit
              </button>
              <button type="button" className="artifact-action" onClick={() => void copy()}>
                <Icon name="copy" size={12} />
                {copied ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                className="artifact-action"
                onClick={() =>
                  downloadFile(downloadName(shown), shown.content, artifactMime(shown))
                }
              >
                <Icon name="paperclip" size={12} />
                Download
              </button>
            </>
          )}
        </div>
      </div>

      <div className="artifact-body">
        {editing ? (
          <div className="artifact-editor">
            <textarea
              className="artifact-editor-area"
              value={draft}
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              aria-label={`Edit ${active.title}`}
            />
            <p className="artifact-preview-note">
              Editing locally — “Save as new version” keeps the previous one and adds yours
              to the history. Nothing leaves your browser.
            </p>
          </div>
        ) : showPreview ? (
          <div className="artifact-preview">
            <iframe
              title={`Preview of ${shown.title}`}
              className="artifact-preview-frame"
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              srcDoc={shown.kind === "svg" ? svgPreviewDoc(shown.content) : shown.content}
              onError={() => setPreviewBlocked(true)}
            />
            <p className="artifact-preview-note">
              Renders this version&apos;s own {kindLabel(shown)} in a sandboxed frame — no
              network, no access to this page.
            </p>
          </div>
        ) : shown.kind === "markdown" ? (
          <div className="artifact-doc">
            <Markdown content={shown.content} />
          </div>
        ) : (
          <>
            {previewBlocked ? (
              <p className="artifact-preview-note artifact-preview-blocked">
                Preview unavailable in this browser — showing the code instead.
              </p>
            ) : null}
            <CodeBlock
              lang={shown.language ?? ""}
              text={shown.content}
              label={shown.title}
            />
          </>
        )}
      </div>
    </aside>
  );
}
