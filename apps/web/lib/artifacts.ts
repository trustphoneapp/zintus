/**
 * Artifact detection — pure, DOM-free, unit-tested.
 *
 * An "artifact" is a substantial, self-contained block in an assistant answer
 * that deserves its own workspace (the side panel) instead of scrolling past it
 * inline: a sizeable code block, a full HTML document, an SVG image, or a long
 * markdown document. Small, incidental snippets stay inline in the bubble — the
 * thresholds here are deliberately conservative so we DON'T over-extract.
 *
 * Honesty: this only classifies and slices the model's OWN text. It never runs
 * or fetches anything; the panel renders the result (and any preview runs in a
 * sandboxed iframe — see ArtifactPanel.tsx).
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
  /**
   * Stable id the MODEL declared via a ```artifact id="…"``` tag, when present.
   * Identity (see foldArtifactVersions) prefers this over any title/content
   * heuristic. Absent for untagged, heuristically-detected blocks.
   */
  declaredId?: string;
  /**
   * Provenance — which model/provider produced this body, and its dollar cost.
   * Set by the conversation layer from the message's ChatMeta (NOT by the pure
   * text detector). This is the router-native edge: "built by DeepSeek · $0.0008",
   * cost a single-vendor canvas can't surface. Absent for user edits.
   */
  model?: string;
  provider?: string;
  costUsd?: number;
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

/** Attributes parsed from a model-declared ```artifact …``` fence info string. */
interface ArtifactTag {
  id?: string;
  title?: string;
  type?: ArtifactKind;
  language?: string;
}

/**
 * Parse a model-declared artifact fence info string, e.g.
 *   artifact id="auth-mw" title="Auth middleware" type="code" lang="ts"
 * Returns null for an ordinary fence (```ts, ```python, …). Quotes required;
 * unknown `type` is ignored (kind is then inferred from the body/lang).
 */
export function parseArtifactTag(info: string): ArtifactTag | null {
  const trimmed = info.trim();
  if (!/^artifact(?:\s|$)/i.test(trimmed)) return null;
  const attrs: Record<string, string> = {};
  const RE = /([A-Za-z_]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(trimmed)) !== null) attrs[m[1]!.toLowerCase()] = m[2]!;
  const typeRaw = (attrs.type ?? "").toLowerCase();
  const type = (["code", "html", "svg", "markdown"] as const).find((k) => k === typeRaw);
  return {
    id: attrs.id?.trim() || undefined,
    title: attrs.title?.trim() || undefined,
    type,
    language: (attrs.lang ?? attrs.language)?.trim() || undefined,
  };
}

/** Best-effort kind when the model omitted `type` on a tagged block. */
function inferKind(content: string, language?: string): ArtifactKind {
  const lang = (language ?? "").toLowerCase();
  if (lang === "html" || looksLikeHtmlDoc(content)) return "html";
  if (lang === "svg" || looksLikeSvg(content)) return "svg";
  if (lang === "md" || lang === "markdown") return "markdown";
  return "code";
}

/** Title for a tagged block when the model omitted `title`. */
function declaredTitle(kind: ArtifactKind, content: string, language?: string): string {
  if (kind === "html") return htmlTitle(content);
  if (kind === "markdown") return docTitle(content);
  if (kind === "svg") return "SVG image";
  return codeTitle(content, language ?? "");
}

/**
 * Build a Draft from a model-declared tag — ALWAYS artifact-worthy (no size
 * gate): the model asked for it explicitly, so an 8-line tagged config counts.
 */
function declaredDraft(tag: ArtifactTag, content: string): Draft {
  const kind = tag.type ?? inferKind(content, tag.language);
  const language =
    tag.language ?? (kind === "html" ? "html" : kind === "svg" ? "svg" : undefined);
  return {
    kind,
    language,
    title: tag.title ?? declaredTitle(kind, content, language),
    content,
    declaredId: tag.id,
  };
}

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

  // 1) Fenced blocks. A model-declared ```artifact …``` tag is honoured FIRST
  //    (explicit id/type/title, bypasses the size heuristic); otherwise fall
  //    back to the size/shape heuristic for incidental code / HTML / SVG.
  for (const fence of parseFences(messageText)) {
    const tag = parseArtifactTag(fence.lang);
    if (tag) {
      drafts.push(declaredDraft(tag, fence.content));
      continue;
    }
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

/* ── Per-message extraction cache + streaming completeness (goal 3) ─────────
 * The chat view extracts artifacts for the WHOLE conversation on every render,
 * which during streaming fires on every token. These pure helpers let the caller
 * re-parse ONLY the message whose content changed (cache hit ⇒ same array, no
 * regex), and hold back an actively-streaming message until its fences close so
 * a half-open block doesn't thrash the panel.
 * ────────────────────────────────────────────────────────────────────────── */

export interface ExtractCacheEntry {
  /** Content length the cached artifacts were parsed from (cheap change check). */
  len: number;
  artifacts: Artifact[];
}

/**
 * Extract a single message's artifacts, reusing the cache when its content is
 * unchanged. A cache hit returns the SAME array instance (no re-parse) — that's
 * what keeps prior messages from being re-parsed on every streamed token.
 */
export function extractArtifactsCached(
  id: string,
  content: string,
  cache: Map<string, ExtractCacheEntry>,
): Artifact[] {
  const prev = cache.get(id);
  if (prev && prev.len === content.length) return prev.artifacts;
  const artifacts = extractArtifacts(content);
  cache.set(id, { len: content.length, artifacts });
  return artifacts;
}

/**
 * Fence-balance heuristic: an odd number of ``` runs means a code/artifact fence
 * is still open (the model is mid-stream), so the block isn't ready to surface.
 */
export function isLikelyComplete(content: string): boolean {
  return ((content.match(/```/g) ?? []).length) % 2 === 0;
}

/**
 * Extract artifacts across a conversation with per-message caching. The
 * `streamingId` message is skipped while its fences are unbalanced, so a
 * half-written artifact doesn't flash into the panel. Ids are namespaced per
 * message (`<messageId>:<artifactId>`) so two turns never collide.
 */
export function extractConversationArtifacts(
  messages: ReadonlyArray<{
    id: string;
    role: string;
    content: string;
    /** Provenance for THIS turn (model/provider/cost) — attached to its artifacts. */
    meta?: { model?: string; provider?: string; costUsd?: number };
  }>,
  cache: Map<string, ExtractCacheEntry>,
  opts?: { streamingId?: string },
): { flat: Artifact[]; byMessage: Record<string, Artifact[]> } {
  const flat: Artifact[] = [];
  const byMessage: Record<string, Artifact[]> = {};
  for (const m of messages) {
    if (m.role !== "assistant" || !m.content) continue;
    if (m.id === opts?.streamingId && !isLikelyComplete(m.content)) continue;
    const arts = extractArtifactsCached(m.id, m.content, cache).map((a) => ({
      ...a,
      id: `${m.id}:${a.id}`,
      model: m.meta?.model,
      provider: m.meta?.provider,
      costUsd: m.meta?.costUsd,
    }));
    if (arts.length > 0) {
      byMessage[m.id] = arts;
      flat.push(...arts);
    }
  }
  return { flat, byMessage };
}

/**
 * Total dollar cost a versioned artifact has incurred — the sum over its model
 * versions' `costUsd` (user edits are free). Router-native: surfaces what this
 * artifact actually cost to produce across however many model turns built it.
 */
export function artifactTotalCost(a: VersionedArtifact): number {
  return a.versions.reduce((sum, v) => sum + (v.costUsd ?? 0), 0);
}

/**
 * ESTIMATE the dollar cost of re-baking an artifact on a model whose input rate
 * is `inputUsdPerMTok` (feature #2). Heuristic only — the true cost is known
 * solely after the call runs, so any UI MUST label this "est." (the research's
 * hard requirement; never present it as a confirmed charge). Token count ≈
 * chars/4 for the body + a fixed prompt overhead; ×`inOutFactor` approximates
 * input+output. A free model (rate 0) estimates $0. Deterministic + pure.
 */
export function estimateRebakeCostUsd(
  content: string,
  inputUsdPerMTok: number,
  opts?: { promptOverheadTokens?: number; inOutFactor?: number },
): number {
  const overhead = opts?.promptOverheadTokens ?? 600;
  const factor = opts?.inOutFactor ?? 1.4;
  const tokens = Math.ceil(content.length / 4) + overhead;
  return (tokens / 1_000_000) * Math.max(0, inputUsdPerMTok) * factor;
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
 * Serialise an artifact back into a model-declared ```artifact …``` fence — the
 * inverse of the tag parser. Used to RE-FEED the user's current version on the
 * next turn (goal 4) so edits accumulate on the version they're looking at. The
 * declared id (or the folded stable id) carries through so the reply versions
 * the same artifact. Pure string builder; round-trips through extractArtifacts.
 */
export function buildArtifactTag(a: {
  kind: ArtifactKind;
  title: string;
  content: string;
  language?: string;
  declaredId?: string;
  id?: string;
}): string {
  const id = a.declaredId ?? a.id;
  const idAttr = id ? ` id="${id.replace(/"/g, "")}"` : "";
  const langAttr = a.language ? ` lang="${a.language.replace(/"/g, "")}"` : "";
  const title = a.title.replace(/"/g, "'");
  return `\`\`\`artifact${idAttr} title="${title}" type="${a.kind}"${langAttr}\n${a.content}\n\`\`\``;
}

/**
 * The full re-feed message: a short instruction + the tagged current version,
 * delivered as ordinary user-role content (no system authority — same posture
 * as the context-compiler's untrusted-data convention).
 */
export function buildArtifactRefeed(a: {
  kind: ArtifactKind;
  title: string;
  content: string;
  language?: string;
  declaredId?: string;
  id?: string;
}): string {
  return (
    `Current version of "${a.title}" — apply my next request to THIS version ` +
    `and re-emit it with the same artifact id:\n\n${buildArtifactTag(a)}`
  );
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
 * body still merges into the same artifact. All helpers below are DOM-free.
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
  /** Provenance carried from the producing turn's ChatMeta (model versions only). */
  model?: string;
  provider?: string;
  costUsd?: number;
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
 * @deprecated Title-based identity. Superseded by {@link stableArtifactKey} +
 * the similarity matching in {@link foldArtifactVersions}, which prefer a
 * model-declared id and otherwise survive title/first-line changes (and don't
 * merge two unrelated untitled blocks that happen to share a heuristic title).
 * Retained for backward compatibility; not used by folding anymore.
 */
export function artifactIdentity(a: {
  kind: ArtifactKind;
  title: string;
}): string {
  return `${a.kind}::${a.title.trim().toLowerCase()}`;
}

/* ── Stable identity (goal 2) ──────────────────────────────────────────────
 * Identity is resolved in priority order:
 *   1) a model-declared id (`declaredId`) — exact, survives any body/title edit;
 *   2) for untagged blocks, same `kind` + content similarity (Jaccard over
 *      character trigrams) above a threshold — a revised body still folds into
 *      the prior version, while two genuinely different blocks stay separate.
 * All pure + deterministic (no Date.now / no randomness in the key).
 * ────────────────────────────────────────────────────────────────────────── */

const SIMILARITY_THRESHOLD = 0.5;

/** Character k-gram shingles over normalised (lower, whitespace-collapsed) text.
 *  k=2 (bigrams): robust for both short bodies (an SVG one-liner) and long files,
 *  while still separating genuinely different blocks at the 0.5 threshold. */
function shingles(text: string, k = 2): Set<string> {
  const norm = text.toLowerCase().replace(/\s+/g, " ").trim();
  const out = new Set<string>();
  if (norm.length <= k) {
    if (norm) out.add(norm);
    return out;
  }
  for (let i = 0; i + k <= norm.length; i += 1) out.add(norm.slice(i, i + k));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Deterministic identity key. `decl:<id>` for a model-declared artifact, else a
 * content+kind anchor for the FIRST version (so the entry's id is stable for the
 * life of the conversation while later revised bodies fold in via similarity).
 */
export function stableArtifactKey(a: {
  kind: ArtifactKind;
  content: string;
  declaredId?: string;
}): string {
  return a.declaredId ? `decl:${a.declaredId}` : `sim:${a.kind}:${hash(a.content)}`;
}

function latestContent(v: VersionedArtifact): string {
  return v.versions[v.versions.length - 1]!.content;
}

/** Best same-kind, NON-declared existing artifact whose latest body is similar. */
function findSimilarIndex(result: VersionedArtifact[], a: Artifact): number {
  const sa = shingles(a.content);
  let best = -1;
  let bestScore = SIMILARITY_THRESHOLD;
  for (let i = 0; i < result.length; i += 1) {
    const r = result[i]!;
    if (r.kind !== a.kind) continue;
    if (r.id.startsWith("decl:")) continue; // declared artifacts merge only by id
    const score = jaccard(sa, shingles(latestContent(r)));
    if (score >= bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return best;
}

type IncomingArtifact = Pick<Artifact, "content" | "kind" | "title"> & {
  language?: string;
  id?: string;
  model?: string;
  provider?: string;
  costUsd?: number;
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
      model: incoming.model,
      provider: incoming.provider,
      costUsd: incoming.costUsd,
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
    model: incoming.model,
    provider: incoming.provider,
    costUsd: incoming.costUsd,
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
 * artifacts sharing a STABLE identity collapse into one entry whose versions are
 * the successive bodies, in order. First-seen order is preserved.
 *
 * Identity (goal 2): a model-declared id matches exactly; otherwise an untagged
 * block folds into an existing same-kind artifact when its body is similar
 * enough (so a revised body — e.g. a changed first comment — appends v2), and
 * two genuinely different untitled blocks stay separate even if the heuristic
 * gave them the same title. The folded entry's `id` is {@link stableArtifactKey}
 * of its first version, so it's stable for the life of the conversation.
 */
export function foldArtifactVersions(
  artifacts: Artifact[],
  now: number = Date.now(),
): VersionedArtifact[] {
  const result: VersionedArtifact[] = [];
  const byDeclaredId = new Map<string, number>();
  for (const a of artifacts) {
    let idx = -1;
    if (a.declaredId) {
      const found = byDeclaredId.get(a.declaredId);
      if (found !== undefined) idx = found;
    } else {
      idx = findSimilarIndex(result, a);
    }
    if (idx === -1) {
      const seeded = upsertArtifactVersion(null, a, { source: "model", createdAt: now });
      seeded.id = stableArtifactKey(a);
      result.push(seeded);
      idx = result.length - 1;
      if (a.declaredId) byDeclaredId.set(a.declaredId, idx);
    } else {
      result[idx] = upsertArtifactVersion(result[idx]!, a, { source: "model", createdAt: now });
    }
  }
  return result;
}

/* ── Inline diff between versions (feature #3) ─────────────────────────────
 * Pure, dependency-free LCS line diff so the panel can show what changed
 * between two artifact versions (the review gate for edits). DOM-free + tested.
 * ────────────────────────────────────────────────────────────────────────── */

export type DiffOp = { type: "same" | "add" | "del"; text: string };

/** Guard: above this line-product the O(m·n) LCS is skipped for a coarse diff. */
const DIFF_MAX_PRODUCT = 4_000_000; // ~2000×2000 lines

/**
 * Line-level diff of `before` → `after` as a flat op list (same/add/del), via a
 * longest-common-subsequence backtrace. For very large inputs it degrades to a
 * whole-block replace (all del then all add) to stay fast.
 */
export function lineDiff(before: string, after: string): DiffOp[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const m = a.length;
  const n = b.length;
  if (m * n > DIFF_MAX_PRODUCT) {
    return [
      ...a.map((text): DiffOp => ({ type: "del", text })),
      ...b.map((text): DiffOp => ({ type: "add", text })),
    ];
  }
  // dp[i][j] = LCS length of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ type: "same", text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: "del", text: a[i]! });
      i += 1;
    } else {
      ops.push({ type: "add", text: b[j]! });
      j += 1;
    }
  }
  while (i < m) ops.push({ type: "del", text: a[i++]! });
  while (j < n) ops.push({ type: "add", text: b[j++]! });
  return ops;
}

/** Added/removed line counts for a diff (for the "+N −M" header). */
export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === "add") added += 1;
    else if (op.type === "del") removed += 1;
  }
  return { added, removed };
}
