/**
 * Artifact detection — pure, DOM-free, unit-tested.
 *
 * An "artifact" is a substantial, self-contained block in an assistant answer
 * that deserves its own workspace (a full-screen modal) instead of scrolling
 * past it inline: a sizeable code block, a full HTML document, an SVG image, or
 * a long markdown document. Small, incidental snippets stay inline in the
 * bubble — the thresholds here are deliberately conservative so we DON'T
 * over-extract.
 *
 * Honesty: this only classifies and slices the model's OWN text. It never runs
 * or fetches anything; on mobile the React Native view renders the result as
 * monospace source (there is NO iframe — HTML is shown as code, never executed).
 *
 * NOTE: the detection + versioning logic below is kept byte-for-byte identical
 * to apps/web/lib/artifacts.ts and apps/desktop/lib/artifacts.ts — the
 * codebase's per-app copy pattern for shared pure logic (cf. builtin-tools.ts).
 * Only this header comment differs.
 */

export type ArtifactKind = "code" | "html" | "svg" | "markdown";

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  /** Fenced-code language tag (when known), e.g. "ts", "python". */
  language?: string;
  /** Short, derived caption for the list + download name. */
  title: string;
  /** The artifact's own content (code body, HTML source, SVG, or full doc). */
  content: string;
}

/** A code block of at least this many non-blank lines is artifact-worthy. */
const MIN_CODE_LINES = 15;
/** …or this many characters, for dense one-liner-heavy blocks. */
const MIN_CODE_CHARS = 600;
/** A long markdown doc needs at least this many headings + this much prose. */
const MIN_DOC_HEADINGS = 2;
const MIN_DOC_LINES = 10;
const MIN_DOC_CHARS = 700;

/** Languages we recognise for the download extension + a nicer default title. */
const LANG_EXT: Record<string, string> = {
  ts: "ts", typescript: "ts", tsx: "tsx", js: "js", javascript: "js",
  jsx: "jsx", py: "py", python: "py", rs: "rs", rust: "rs", go: "go",
  java: "java", c: "c", cpp: "cpp", "c++": "cpp", cs: "cs", rb: "rb",
  ruby: "rb", php: "php", swift: "swift", kt: "kt", kotlin: "kt",
  sh: "sh", bash: "sh", zsh: "sh", sql: "sql", json: "json", yaml: "yaml",
  yml: "yaml", toml: "toml", css: "css", scss: "scss", html: "html",
  svg: "svg", xml: "xml", md: "md", markdown: "md",
};

interface Fence {
  lang: string;
  content: string;
  raw: string;
  start: number;
  end: number;
}

/** Matches a fenced code block: ```lang\n …body… \n``` */
const FENCE_RE = /```([^\n`]*)\r?\n([\s\S]*?)```/g;

function parseFences(text: string): Fence[] {
  const out: Fence[] = [];
  let m: RegExpExecArray | null;
  FENCE_RE.lastIndex = 0;
  while ((m = FENCE_RE.exec(text)) !== null) {
    const lang = (m[1] ?? "").trim();
    const content = (m[2] ?? "").replace(/\r?\n$/, "");
    out.push({
      lang,
      content,
      raw: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

function nonBlankLines(text: string): number {
  return text.split("\n").filter((l) => l.trim() !== "").length;
}

function looksLikeHtmlDoc(text: string): boolean {
  return /<!doctype\s+html|<html[\s>]/i.test(text);
}

function looksLikeSvg(text: string): boolean {
  return /<svg[\s>][\s\S]*<\/svg>/i.test(text);
}

/** Pull a `<title>` from an HTML doc, else a calm default. */
function htmlTitle(content: string): string {
  const m = content.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (m && m[1]?.trim()) return m[1].trim().slice(0, 80);
  return "HTML document";
}

/** First leading comment or named def/class/function, else a language label. */
function codeTitle(content: string, lang: string): string {
  const first = content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (first) {
    const comment = first.match(/^(?:\/\/|#|--|;|\/\*)\s*(.+?)\s*(?:\*\/)?$/);
    if (comment && comment[1] && !/^[-=*]+$/.test(comment[1])) {
      return comment[1].slice(0, 80);
    }
    const named = content.match(
      /(?:function|class|def|interface|type|struct|fn|func|const|export\s+(?:default\s+)?(?:function|class|const))\s+([A-Za-z_$][\w$]*)/,
    );
    if (named && named[1]) return named[1];
  }
  const pretty = lang ? lang[0]!.toUpperCase() + lang.slice(1) : "Code";
  return `${pretty} snippet`;
}

/** First markdown heading text, else a default. */
function docTitle(content: string): string {
  const m = content.match(/^#{1,6}\s+(.+)$/m);
  if (m && m[1]?.trim()) return m[1].trim().slice(0, 80);
  return "Document";
}

/** Stable, dependency-free hash so artifact ids don't change between renders. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

type Draft = Omit<Artifact, "id">;

function classifyFence(f: Fence): Draft | null {
  const lang = f.lang.toLowerCase();
  const content = f.content;
  if (lang === "html" || looksLikeHtmlDoc(content)) {
    return { kind: "html", language: "html", title: htmlTitle(content), content };
  }
  if (lang === "svg" || looksLikeSvg(content)) {
    return { kind: "svg", language: "svg", title: "SVG image", content };
  }
  const worthy =
    nonBlankLines(content) >= MIN_CODE_LINES || content.length >= MIN_CODE_CHARS;
  if (!worthy) return null;
  return {
    kind: "code",
    language: lang || undefined,
    title: codeTitle(content, lang),
    content,
  };
}

/**
 * Detect every artifact-worthy block in an assistant message, in document
 * order. Returns [] for empty / no-artifact input. Ids are stable for a given
 * message and unique within it.
 */
export function extractArtifacts(messageText: string): Artifact[] {
  if (!messageText || messageText.trim() === "") return [];
  const drafts: Draft[] = [];

  // 1) Fenced code / HTML / SVG blocks.
  for (const fence of parseFences(messageText)) {
    const draft = classifyFence(fence);
    if (draft) drafts.push(draft);
  }

  // Prose with fences removed — for raw (un-fenced) docs and the markdown check.
  const prose = messageText.replace(FENCE_RE, "").trim();

  // 2) A full HTML document pasted raw (not fenced).
  if (looksLikeHtmlDoc(prose)) {
    const m = prose.match(/(<!doctype\s+html[\s\S]*<\/html>|<html[\s\S]*<\/html>)/i);
    if (m && m[1]) {
      drafts.push({
        kind: "html",
        language: "html",
        title: htmlTitle(m[1]),
        content: m[1].trim(),
      });
    }
  }

  // 3) A standalone SVG pasted raw (not fenced, not already inside the HTML doc).
  if (looksLikeSvg(prose) && !looksLikeHtmlDoc(prose)) {
    const m = prose.match(/<svg[\s>][\s\S]*<\/svg>/i);
    if (m && m[0]) {
      drafts.push({ kind: "svg", language: "svg", title: "SVG image", content: m[0].trim() });
    }
  }

  // 4) A long markdown document — several headings over substantial prose.
  // Conservative so a normal two-heading answer doesn't get pulled out.
  const headings = (prose.match(/^#{1,6}\s+/gm) ?? []).length;
  if (
    headings >= MIN_DOC_HEADINGS &&
    nonBlankLines(prose) >= MIN_DOC_LINES &&
    (headings >= 3 || prose.length >= MIN_DOC_CHARS)
  ) {
    drafts.push({ kind: "markdown", title: docTitle(prose), content: messageText.trim() });
  }

  return drafts.map((d, i) => ({ id: `artifact-${i}-${hash(d.kind + d.content)}`, ...d }));
}

/** File extension for an artifact's Download action. */
export function artifactExtension(a: Artifact): string {
  if (a.kind === "html") return "html";
  if (a.kind === "svg") return "svg";
  if (a.kind === "markdown") return "md";
  return (a.language && LANG_EXT[a.language.toLowerCase()]) || "txt";
}

/** MIME type for an artifact's Download action. */
export function artifactMime(a: Artifact): string {
  if (a.kind === "html") return "text/html";
  if (a.kind === "svg") return "image/svg+xml";
  if (a.kind === "markdown") return "text/markdown";
  return "text/plain";
}

/**
 * Rewrite a message body so each EXTRACTED code/HTML/SVG block becomes a short
 * one-line reference (it lives in the panel now), keeping surrounding prose
 * intact. Markdown-document artifacts are left untouched — they ARE the prose.
 * Pure string transform; safe to render through the existing markdown path.
 */
export function summarizeArtifactBody(
  messageText: string,
  artifacts: Artifact[],
): string {
  const blocks = artifacts.filter((a) => a.kind !== "markdown");
  if (blocks.length === 0) return messageText;
  let text = messageText;

  // Replace fenced blocks from the end so earlier offsets stay valid.
  const fences = parseFences(messageText).sort((a, b) => b.start - a.start);
  const consumed = new Set<Artifact>();
  for (const fence of fences) {
    const a = blocks.find((x) => !consumed.has(x) && x.content === fence.content);
    if (!a) continue;
    consumed.add(a);
    text = text.slice(0, fence.start) + referenceLine(a) + text.slice(fence.end);
  }

  // Any raw (un-fenced) HTML/SVG that wasn't a fence.
  for (const a of blocks) {
    if (consumed.has(a)) continue;
    if (text.includes(a.content)) {
      text = text.replace(a.content, referenceLine(a).trim());
      consumed.add(a);
    }
  }
  return text;
}

function referenceLine(a: Artifact): string {
  const kind =
    a.kind === "html" ? "HTML" : a.kind === "svg" ? "SVG" : (a.language ?? "code");
  return `\n> 📄 ${a.title} — ${kind} in the artifacts panel\n`;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Iterative artifacts — versioning model.
 *
 * The detector above is a viewer: it slices the model's text into Artifacts.
 * Real "Artifacts / Canvas" parity means one artifact has a STABLE IDENTITY
 * across a conversation and a list of VERSIONS: each time the model re-emits the
 * same artifact (same kind + title) we append a version instead of spawning a
 * brand-new artifact, and the user can save their own edits as a version too.
 *
 * This is a pure layer ON TOP of extractArtifacts — existing callers/tests are
 * untouched. Identity is content-free (kind + normalised title) so a revised
 * body still merges into the same artifact. All helpers below are DOM-free and
 * kept byte-for-byte identical to apps/web/lib/artifacts.ts.
 * ────────────────────────────────────────────────────────────────────────── */

/** Where a version came from: the model's reply, or a local user edit. */
export type ArtifactSource = "model" | "user-edit";

/** One immutable snapshot of an artifact's body. */
export interface ArtifactVersion {
  content: string;
  kind: ArtifactKind;
  language?: string;
  title: string;
  /** Human label, contiguous within the artifact: "v1", "v2", … */
  label: string;
  /** Origin of this snapshot. */
  source: ArtifactSource;
  /** Epoch ms when the snapshot was captured. */
  createdAt: number;
  /** The flat Artifact id this version was extracted from (for UI mapping). */
  sourceId?: string;
}

/** An artifact with a stable identity and its ordered version history. */
export interface VersionedArtifact {
  /** Stable across the conversation (derived from identity, not content). */
  id: string;
  /** kind / language / title always reflect the LATEST version. */
  kind: ArtifactKind;
  language?: string;
  title: string;
  versions: ArtifactVersion[];
}

/**
 * Content-free identity anchor: same kind + same (normalised) title ⇒ same
 * artifact, even if the body changed. This is what lets a re-emitted artifact
 * append a version rather than duplicate. Kept deliberately simple/stable.
 */
export function artifactIdentity(a: {
  kind: ArtifactKind;
  title: string;
}): string {
  return `${a.kind}::${a.title.trim().toLowerCase()}`;
}

type IncomingArtifact = Pick<Artifact, "content" | "kind" | "title"> & {
  language?: string;
  id?: string;
};

/**
 * Append `incoming` to `existing` as a new version, or seed a fresh
 * VersionedArtifact when `existing` is null. If the incoming body is identical
 * to the latest version's body, this is a no-op (no duplicate version) — so a
 * message that re-renders unchanged never bloats the history. The top-level
 * kind/language/title always track the newest version.
 */
export function upsertArtifactVersion(
  existing: VersionedArtifact | null,
  incoming: IncomingArtifact,
  opts?: { source?: ArtifactSource; createdAt?: number },
): VersionedArtifact {
  const source: ArtifactSource = opts?.source ?? "model";
  const createdAt = opts?.createdAt ?? Date.now();

  if (!existing) {
    const v: ArtifactVersion = {
      content: incoming.content,
      kind: incoming.kind,
      language: incoming.language,
      title: incoming.title,
      label: "v1",
      source,
      createdAt,
      sourceId: incoming.id,
    };
    return {
      id: artifactIdentity(incoming),
      kind: incoming.kind,
      language: incoming.language,
      title: incoming.title,
      versions: [v],
    };
  }

  const last = existing.versions[existing.versions.length - 1];
  if (last && last.content === incoming.content) {
    // Same body — keep history clean, but adopt any newer source id so inline
    // references from the latest message still resolve to this artifact.
    if (incoming.id && last.sourceId !== incoming.id) {
      const versions = existing.versions.slice();
      versions[versions.length - 1] = { ...last, sourceId: incoming.id };
      return { ...existing, versions };
    }
    return existing;
  }

  const v: ArtifactVersion = {
    content: incoming.content,
    kind: incoming.kind,
    language: incoming.language,
    title: incoming.title,
    label: `v${existing.versions.length + 1}`,
    source,
    createdAt,
    sourceId: incoming.id,
  };
  return {
    id: existing.id,
    kind: incoming.kind,
    language: incoming.language,
    title: incoming.title,
    versions: [...existing.versions, v],
  };
}

/**
 * A plain Artifact view of one version — so `artifactExtension`/`artifactMime`,
 * Copy, Download and the preview all work per-version with zero special-casing.
 * Out-of-range indices clamp to the nearest valid version.
 */
export function artifactAtVersion(a: VersionedArtifact, i: number): Artifact {
  const idx = Math.max(0, Math.min(i, a.versions.length - 1));
  const v = a.versions[idx]!;
  return {
    id: a.id,
    kind: v.kind,
    language: v.language,
    title: v.title,
    content: v.content,
  };
}

/**
 * Fold a flat, document-ordered list of extracted Artifacts (typically one
 * conversation's worth, ids namespaced per message) into VersionedArtifacts:
 * artifacts sharing an identity collapse into one entry whose versions are the
 * successive bodies, in order. First-seen order is preserved.
 */
export function foldArtifactVersions(
  artifacts: Artifact[],
  now: number = Date.now(),
): VersionedArtifact[] {
  const order: string[] = [];
  const byKey = new Map<string, VersionedArtifact>();
  for (const a of artifacts) {
    const key = artifactIdentity(a);
    const existing = byKey.get(key) ?? null;
    if (!existing) order.push(key);
    byKey.set(key, upsertArtifactVersion(existing, a, { source: "model", createdAt: now }));
  }
  return order.map((k) => byKey.get(k)!);
}
