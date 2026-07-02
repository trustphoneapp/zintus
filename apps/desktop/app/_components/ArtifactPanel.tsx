"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Layers,
  X,
  Copy,
  Download,
  Pencil,
  Check,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import {
  artifactExtension,
  artifactMime,
  type Artifact,
  type ArtifactVersion,
  type VersionedArtifact,
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
 * Desktop artifacts workspace — a right-side drawer, now ITERATIVE.
 *
 * Lists the conversation's artifacts (one entry per identity, re-emitted bodies
 * folded into versions) and shows the selected one with Copy + Download, a
 * version switcher ("vN of M"), and an Edit affordance that saves a local
 * "user-edit" version. Edits live only in memory — no server round-trip.
 *
 * Unlike web, there is NO iframe preview: HTML/SVG/code are shown as
 * syntax-highlighted source and a long markdown doc through the shared Markdown
 * renderer. Nothing here is executed — the panel only displays text.
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

  const [copied, setCopied] = useState(false);
  const [userVersions, setUserVersions] = useState<Record<string, ArtifactVersion[]>>({});
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const versions = useMemo(
    () => (active ? allVersionsOf(active, userVersions) : []),
    [active, userVersions],
  );
  const lastIndex = versions.length - 1;
  const sel = active ? Math.min(selected[active.id] ?? lastIndex, lastIndex) : 0;
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

  useEffect(() => {
    setCopied(false);
    setEditing(false);
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
    if (!shown) return;
    try {
      await navigator.clipboard.writeText(shown.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable — ignore */
    }
  }

  function setVersion(i: number) {
    if (!active) return;
    setSelected((prev) => ({ ...prev, [active.id]: Math.max(0, Math.min(i, lastIndex)) }));
    setEditing(false);
  }

  function startEditing() {
    if (!shown) return;
    setDraft(shown.content);
    setEditing(true);
  }

  function saveVersion() {
    if (!active || !shown) return;
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
    const newIndex = versions.length;
    setUserVersions((prev) => ({ ...prev, [active.id]: [...(prev[active.id] ?? []), v] }));
    setSelected((prev) => ({ ...prev, [active.id]: newIndex }));
    setEditing(false);
  }

  if (!active || !shown || !shownVersion) return null;

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

        {versions.length > 1 ? (
          <div className="artifact-versions" role="group" aria-label="Version history">
            <button
              type="button"
              className="artifact-version-nav"
              onClick={() => setVersion(sel - 1)}
              disabled={sel <= 0}
              aria-label="Previous version"
            >
              <ChevronLeft size={13} />
            </button>
            <span className="artifact-version-label">
              v{sel + 1} of {versions.length}
              <span
                className={`artifact-version-source artifact-version-source-${shownVersion.source}`}
              >
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
              <ChevronRight size={13} />
            </button>
          </div>
        ) : null}

        <div className="artifact-toolbar">
          <span className="artifact-kind-chip" title={active.title}>
            {kindLabel(shown)}
          </span>
          <div className="artifact-actions">
            {editing ? (
              <>
                <button type="button" className="artifact-action" onClick={saveVersion}>
                  <Check size={12} />
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
                  <Pencil size={12} />
                  Edit
                </button>
                <button type="button" className="artifact-action" onClick={() => void copy()}>
                  <Copy size={12} />
                  {copied ? "Copied" : "Copy"}
                </button>
                <button
                  type="button"
                  className="artifact-action"
                  onClick={() => {
                    void saveTextFile(
                      downloadName(shown),
                      shown.content,
                      artifactMime(shown),
                    );
                  }}
                >
                  <Download size={12} />
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
              <p className="artifact-panel-note">
                Editing locally — &ldquo;Save as new version&rdquo; keeps the previous one
                and adds yours to the history. Nothing is executed.
              </p>
            </div>
          ) : shown.kind === "markdown" ? (
            <div className="artifact-doc">
              <Markdown content={shown.content} />
            </div>
          ) : (
            <>
              <CodeBlock
                lang={shown.language ?? ""}
                text={shown.content}
                label={shown.title}
              />
              <p className="artifact-panel-note">
                Shows this version&apos;s own {kindLabel(shown)} — nothing is executed.
              </p>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
