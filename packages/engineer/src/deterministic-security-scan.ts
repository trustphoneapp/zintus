import { randomUUID } from "node:crypto";
import {
  SecurityFindingRecordSchema,
  type SecurityFindingRecord,
} from "./verification-contracts.js";

/** Pure deterministic scanner. Caller supplies identity/time so semantics can be replayed. */
export function scanDiffForSecurity(input: {
  runId: string;
  diff: string;
  createdAt: string;
  idFactory?: () => string;
}): SecurityFindingRecord[] {
  const rules = [
    { category: "POSSIBLE_SECRET", severity: "CRITICAL" as const, pattern: /^\+.*(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{8,}["']/i,
      description: "A newly added line appears to contain a hard-coded credential." },
    { category: "UNSAFE_EVAL", severity: "HIGH" as const, pattern: /^\+.*\beval\s*\(/,
      description: "A newly added line invokes eval()." },
    { category: "SHELL_EXECUTION", severity: "MEDIUM" as const, pattern: /^\+.*\b(?:exec|spawn)\s*\([^\n]*shell\s*:\s*true/,
      description: "A newly added process invocation enables a shell." },
    { category: "TLS_VERIFICATION_DISABLED", severity: "CRITICAL" as const, pattern: /^\+.*(?:rejectUnauthorized|verify)\s*[:=]\s*false\b/i,
      description: "A newly added line disables transport certificate verification." },
    { category: "COOKIE_SECURITY_DISABLED", severity: "HIGH" as const, pattern: /^\+.*(?:httpOnly|secure)\s*:\s*false\b/i,
      description: "A newly added line disables a cookie security control." },
  ];
  const negativeConstraints = [
    { category: "AUTHENTICATION_CONTROL_REMOVED", pattern: /\b(?:authenticate|requireAuth|verifyToken|verifySession|currentUser)\b/i,
      description: "The diff removes an authentication control without a replacement in the same file." },
    { category: "AUTHORIZATION_CONTROL_REMOVED", pattern: /\b(?:authorize|requirePermission|hasPermission|canAccess|enforceRbac)\b/i,
      description: "The diff removes an authorization control without a replacement in the same file." },
    { category: "INPUT_VALIDATION_REMOVED", pattern: /\b(?:safeParse|validate|sanitize|escapeHtml)\s*\(/i,
      description: "The diff removes input validation or sanitization without a replacement in the same file." },
    { category: "CSRF_CONTROL_REMOVED", pattern: /\b(?:csrf|sameSite|originCheck)\b/i,
      description: "The diff removes a request-forgery control without a replacement in the same file." },
  ];
  const findings: SecurityFindingRecord[] = [];
  const changedLines = new Map<string, { added: string[]; removed: string[] }>();
  let file: string | null = null;
  let newLine = 0;
  for (const line of input.diff.split("\n")) {
    if (line.startsWith("+++ b/")) file = line.slice(6);
    else if (line.startsWith("@@")) {
      const match = /\+(\d+)/.exec(line);
      newLine = match ? Number(match[1]) - 1 : 0;
    } else if (newLine > 0 && (line.startsWith("+") && !line.startsWith("+++") || line.startsWith(" "))) {
      newLine += 1;
    }
    if (file && ((line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---")))) {
      const changes = changedLines.get(file) ?? { added: [], removed: [] };
      (line.startsWith("+") ? changes.added : changes.removed).push(line.slice(1));
      changedLines.set(file, changes);
    }
    for (const rule of rules) {
      if (!rule.pattern.test(line)) continue;
      // No path/content-based downgrade: a POSSIBLE_SECRET stays CRITICAL even in
      // a test-looking file, because both the path and the content are
      // Builder-authored diff data. A Builder could otherwise smuggle a live
      // credential by naming the file test-ish. A genuine synthetic fixture is a
      // human-resolution matter, not an automatic severity drop.
      findings.push(SecurityFindingRecordSchema.parse({
        securityFindingId: (input.idFactory ?? randomUUID)(), runId: input.runId,
        severity: rule.severity, category: rule.category, description: rule.description,
        file, lineStart: newLine || null, lineEnd: newLine || null,
        evidenceIds: [], status: "OPEN", createdAt: input.createdAt,
      }));
    }
  }
  for (const [changedFile, changes] of changedLines) {
    for (const constraint of negativeConstraints) {
      if (!changes.removed.some((line) => constraint.pattern.test(line)) ||
          changes.added.some((line) => constraint.pattern.test(line))) continue;
      findings.push(SecurityFindingRecordSchema.parse({
        securityFindingId: (input.idFactory ?? randomUUID)(), runId: input.runId,
        severity: "HIGH", category: constraint.category, description: constraint.description,
        file: changedFile, lineStart: null, lineEnd: null, evidenceIds: [], status: "OPEN", createdAt: input.createdAt,
      }));
    }
  }
  return findings;
}

export function securityFindingSemantics(finding: SecurityFindingRecord): unknown {
  return {
    runId: finding.runId, severity: finding.severity, category: finding.category,
    description: finding.description, file: finding.file, lineStart: finding.lineStart,
    lineEnd: finding.lineEnd, evidenceIds: finding.evidenceIds, status: finding.status,
  };
}
