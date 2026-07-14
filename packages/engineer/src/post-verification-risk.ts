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

function changedPathsFromDiff(diff: string): string[] {
  const paths: string[] = [];
  for (const match of diff.matchAll(/^\+\+\+ (.+)$/gm)) {
    const raw = match[1]!;
    if (raw === "/dev/null") continue;
    const decoded = decodeGitPath(raw);
    paths.push(decoded.startsWith("b/") ? decoded.slice(2) : decoded);
  }
  if (paths.length > 0) return paths;
  return [...diff.matchAll(/^diff --git (?:a\/\S+|"a\/(?:\\.|[^"])*") (b\/\S+|"b\/(?:\\.|[^"])*")$/gm)]
    .map((match) => decodeGitPath(match[1]!).replace(/^b\//, ""));
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
