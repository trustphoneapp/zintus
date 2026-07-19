import { RiskFeaturesSchema, type RiskFeatures } from "./contracts.js";

export const POST_VERIFICATION_RISK_POLICY_VERSION = "post-verification-risk-v1" as const;

export interface PostVerificationRiskInput {
  diff: string;
  requiredChecksPassed: boolean;
  retryCount: number;
  testCoveragePercent?: number | null;
  unresolvedWarnings: number;
  securityFindings: Array<{ severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"; category: string; status: string }>;
  reviewerDisagreement?: boolean;
}

const severityRank = { NONE: 0, INFO: 1, LOW: 2, MEDIUM: 3, HIGH: 4, CRITICAL: 5 } as const;

function decodeGitPath(raw: string): string {
  const quoted = raw.startsWith('"') && raw.endsWith('"');
  const value = quoted ? raw.slice(1, -1) : raw;
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character !== "\\") {
      bytes.push(...Buffer.from(character));
      continue;
    }
    const escaped = value[index + 1];
    if (escaped === undefined) { bytes.push(92); continue; }
    if (/[0-7]/.test(escaped)) {
      const octal = value.slice(index + 1).match(/^[0-7]{1,3}/)?.[0] ?? escaped;
      bytes.push(Number.parseInt(octal, 8));
      index += octal.length;
      continue;
    }
    const controls: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
    bytes.push(controls[escaped] ?? escaped.charCodeAt(0));
    index += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

const DIFF_GIT_HEADER = /^diff --git (.+)$/;

/** Strip the `a/` or `b/` diff prefix that `diff --git`, `---`, and `+++` lines carry. */
function stripDiffPrefix(path: string): string {
  return path.replace(/^[ab]\//, "");
}

/**
 * Recover the concrete repository paths for one `diff --git` file block.
 *
 * Git does NOT quote spaces in `diff --git` headers, so the `a/… b/…` split is
 * genuinely ambiguous for unquoted paths that contain spaces. We therefore treat
 * the space-safe body markers as authoritative wherever they exist:
 *   - `rename from` / `rename to` and `copy from` / `copy to` (no `a/`,`b/` prefix)
 *   - the `---` / `+++` file headers (each carries exactly one `a/` or `b/` path)
 * These lines always appear before the first `@@`, so we stop scanning there to
 * avoid mistaking a hunk content line such as `--- foo` for a file header.
 *
 * When a block has no authoritative body markers we fall back to parsing the
 * `diff --git` header, but only when it can be split unambiguously (quoted sides,
 * or unquoted sides that both contain no spaces). Anything else is reported as
 * unresolved so callers can FAIL CLOSED instead of silently dropping the path.
 */
function resolveBlockPaths(headerBody: string, block: string[]): { paths: string[]; ambiguous: boolean } {
  const paths = new Set<string>();
  for (const line of block) {
    if (line.startsWith("@@")) break;
    let match: RegExpMatchArray | null;
    if ((match = line.match(/^rename (?:from|to) (.+)$/)) || (match = line.match(/^copy (?:from|to) (.+)$/))) {
      // rename/copy paths are repository-relative with no `a/`,`b/` prefix.
      paths.add(decodeGitPath(match[1]!));
    } else if ((match = line.match(/^(?:---|\+\+\+) (.+)$/))) {
      const raw = match[1]!;
      if (raw !== "/dev/null") paths.add(stripDiffPrefix(decodeGitPath(raw)));
    }
  }
  if (paths.size > 0) return { paths: [...paths], ambiguous: false };
  const parsed = parseDiffGitHeader(headerBody);
  return parsed ? { paths: parsed, ambiguous: false } : { paths: [], ambiguous: true };
}

/** Parse a `diff --git` header body, returning null when the split is ambiguous. */
function parseDiffGitHeader(body: string): string[] | null {
  // A quoted a-side has a well-defined closing quote, so the separator and the
  // (quoted or unquoted) b-side are unambiguous even with embedded spaces.
  const aQuoted = body.match(/^"a\/(?:\\.|[^"])*"/);
  if (aQuoted) {
    const aToken = aQuoted[0];
    const rest = body.slice(aToken.length);
    if (!rest.startsWith(" ")) return null;
    const bToken = rest.slice(1);
    if (!/^(?:"b\/(?:\\.|[^"])*"|b\/.+)$/.test(bToken)) return null;
    return [stripDiffPrefix(decodeGitPath(aToken)), stripDiffPrefix(decodeGitPath(bToken))];
  }
  // Both sides unquoted: only safe when neither path contains a space, because a
  // single space is then unambiguously the a/b separator.
  const both = body.match(/^(a\/\S+) (b\/\S+)$/);
  if (both) return [stripDiffPrefix(decodeGitPath(both[1]!)), stripDiffPrefix(decodeGitPath(both[2]!))];
  return null;
}

export interface ChangedPathExtraction {
  /** Concrete repository paths recovered from the diff (space- and rename-safe). */
  paths: string[];
  /**
   * `diff --git` header bodies whose paths could not be recovered unambiguously.
   * A non-empty list means the diff's scope is indeterminate and the run must be
   * treated as a scope violation rather than promoted.
   */
  unresolved: string[];
}

/**
 * Decode the final Git diff once for every policy that needs authoritative path
 * scope. Includes BOTH sides of renames/copies and is safe for paths containing
 * spaces; ambiguous unparseable headers are surfaced in `unresolved` so gates can
 * fail closed.
 */
export function extractChangedPaths(diff: string): ChangedPathExtraction {
  const lines = diff.split("\n");
  const paths = new Set<string>();
  const unresolved = new Set<string>();
  let index = 0;
  let sawHeader = false;
  while (index < lines.length) {
    const header = lines[index]!.match(DIFF_GIT_HEADER);
    if (!header) { index += 1; continue; }
    sawHeader = true;
    let cursor = index + 1;
    const block: string[] = [];
    while (cursor < lines.length && !DIFF_GIT_HEADER.test(lines[cursor]!)) {
      block.push(lines[cursor]!);
      cursor += 1;
    }
    const resolved = resolveBlockPaths(header[1]!, block);
    if (resolved.ambiguous) unresolved.add(header[1]!.trim());
    else for (const path of resolved.paths) paths.add(path);
    index = cursor;
  }
  // Plain unified diffs without `diff --git` headers still carry `---`/`+++`.
  if (!sawHeader) {
    for (const match of diff.matchAll(/^(?:\+\+\+|---) (.+)$/gm)) {
      const raw = match[1]!;
      if (raw === "/dev/null") continue;
      paths.add(stripDiffPrefix(decodeGitPath(raw)));
    }
  }
  return { paths: [...paths].sort(), unresolved: [...unresolved].sort() };
}

/**
 * Flat list of every changed path for policies that only need path scope. Any
 * ambiguous/unparseable `diff --git` header is folded in verbatim so it can never
 * be silently dropped (it will not match a specific allowed glob).
 */
export function changedPathsFromDiff(diff: string): string[] {
  const { paths, unresolved } = extractChangedPaths(diff);
  return [...new Set([...paths, ...unresolved])].sort();
}

/** Derives deterministic floors from the actual patch and trusted verification records. */
export function derivePostVerificationRiskFeatures(input: PostVerificationRiskInput): RiskFeatures {
  const changedPaths = changedPathsFromDiff(input.diff);
  const added = [...input.diff.matchAll(/^\+(?!\+\+)(.*)$/gm)].map((match) => match[1] ?? "");
  const removed = [...input.diff.matchAll(/^-(?!--)(.*)$/gm)].map((match) => match[1] ?? "");
  const diffLines = added.length + removed.length;
  const normalized = `${changedPaths.join("\n")}\n${added.join("\n")}\n${removed.join("\n")}`.toLowerCase();
  const openFindings = input.securityFindings.filter((finding) => finding.status === "OPEN");
  const highestSecuritySeverity = openFindings.reduce<keyof typeof severityRank>((highest, finding) =>
    severityRank[finding.severity] > severityRank[highest] ? finding.severity : highest, "NONE");
  const documentationOnly = changedPaths.length > 0 && changedPaths.every((path) =>
    /^(?:docs\/|readme(?:\.|$)|changelog(?:\.|$)|license(?:\.|$))|\.(?:md|mdx|txt|rst)$/i.test(path));
  const generatedLines = added.filter((line) => /generated|do not edit|codegen/i.test(line)).length;
  return RiskFeaturesSchema.parse({
    documentationOnly,
    sensitiveFilesChanged: changedPaths.some((path) => /(?:^|\/)(?:\.env|secrets?|credentials?|id_rsa|\.github\/workflows)(?:\.|\/|$)/i.test(path)),
    touchesAuthentication: /\b(?:auth(?:entication)?|login|session|oauth|passkey|password|token)\b/.test(normalized),
    touchesAuthorization: /\b(?:authori[sz]ation|permission|rbac|access[ _-]?control|role)\b/.test(normalized),
    touchesPayments: /\b(?:payment|billing|invoice|checkout|stripe|currency)\b/.test(normalized),
    changesDatabaseSchema: changedPaths.some((path) => /(?:migration|schema|\.sql$)/i.test(path)) || /\b(?:alter|create|drop) table\b/.test(normalized),
    destructiveProductionOperation: /\b(?:drop table|truncate|delete from|force push|reset --hard)\b/.test(normalized),
    privilegeEscalation: /\b(?:sudo|setuid|cap_sys_admin|privilege escalation)\b/.test(normalized),
    changesInfrastructure: changedPaths.some((path) => /(?:^|\/)(?:dockerfile|\.github\/workflows|terraform|infra|k8s|helm)(?:\.|\/|$)/i.test(path)),
    accessesSecrets: /\b(?:secret|credential|api[_ -]?key|private[_ -]?key)\b/.test(normalized),
    exposesSecrets: openFindings.some((finding) => /secret|credential|private.key/i.test(finding.category) && finding.severity === "CRITICAL"),
    changesDependencies: changedPaths.some((path) => /(?:package\.json|lock|requirements.*\.txt|cargo\.toml|go\.mod)$/i.test(path)),
    changesPublicApi: /\b(?:public api|export (?:type|interface|class|function)|route|endpoint|webhook)\b/.test(normalized),
    requiredChecksPassed: input.requiredChecksPassed,
    testCoveragePercent: input.testCoveragePercent ?? null,
    unresolvedWarnings: input.unresolvedWarnings,
    highestSecuritySeverity,
    retryCount: input.retryCount,
    dependsOnExternalService: /\b(?:https?:\/\/|external service|third.party|webhook)\b/.test(normalized),
    diffLines,
    generatedCodePercent: diffLines === 0 ? 0 : Math.min(100, (generatedLines / diffLines) * 100),
    reviewerDisagreement: input.reviewerDisagreement ?? false,
    suspectedRunnerCompromise: openFindings.some((finding) => /runner|sandbox|environment drift|tamper/i.test(finding.category) && finding.severity === "CRITICAL"),
  });
}
