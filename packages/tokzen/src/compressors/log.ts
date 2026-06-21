// MIT License — see LICENSE file
import { countTokensFast, estimateSavings } from "../tokenizer/count.js";
import { getDefaultCCRStore } from "../ccr/store.js";
import type { CompressContext, CompressResult } from "../pipeline/types.js";

const ANSI_RE = /\x1B\[[0-9;]*[mGKHFJK]/g;

// Patterns for timestamp detection
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/;
const BRACKET_TS_RE = /^\[\d+\]\s*/;
const UNIX_MS_RE = /^\d{13,}\s+/;
const RELATIVE_TS_RE = /^[+\-]?\d+(?:ms|s|m|h)\s+/;

// Log level detection

const LEVEL_RE =
  /\b(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|CRITICAL|EXCEPTION)\b/i;

export interface LogLevelPolicy {
  TRACE?: "keep" | "sample" | "drop";
  DEBUG?: "keep" | "sample" | "drop";
  INFO?: "keep" | "sample" | "drop";
  WARN?: "keep" | "sample" | "drop";
  ERROR?: "keep" | "sample" | "drop";
  FATAL?: "keep" | "sample" | "drop";
}

export interface LogCompressOptions {
  logLevelPolicy?: LogLevelPolicy;
}

// Minimal Drain3-style log template mining
interface DrainCluster {
  template: string[];
  count: number;
  logTokens: string[];
}

class DrainParser {
  private readonly simThreshold: number;
  private clusters: DrainCluster[] = [];

  constructor(opts: { simThreshold?: number; depth?: number } = {}) {
    this.simThreshold = opts.simThreshold ?? 0.5;
    void opts.depth; // depth controls trie branching in full Drain; simplified here
  }

  addLogEntry(line: string): string {
    const tokens = line.split(/\s+/);
    const cluster = this.findCluster(tokens);
    if (cluster) {
      cluster.count++;
      cluster.template = this.mergeTemplate(cluster.template, tokens);
      return cluster.template.join(" ");
    }
    this.clusters.push({ template: [...tokens], count: 1, logTokens: tokens });
    return tokens.join(" ");
  }

  private findCluster(tokens: string[]): DrainCluster | null {
    let best: DrainCluster | null = null;
    let bestSim = this.simThreshold;
    for (const cluster of this.clusters) {
      const sim = this.similarity(cluster.template, tokens);
      if (sim >= bestSim) {
        bestSim = sim;
        best = cluster;
      }
    }
    return best;
  }

  private similarity(templateTokens: string[], tokens: string[]): number {
    if (templateTokens.length !== tokens.length) return 0;
    let matches = 0;
    for (let i = 0; i < templateTokens.length; i++) {
      if (templateTokens[i] === "<*>" || templateTokens[i] === tokens[i]) matches++;
    }
    return matches / templateTokens.length;
  }

  private mergeTemplate(template: string[], tokens: string[]): string[] {
    if (template.length !== tokens.length) return template;
    return template.map((t, i) => (t === tokens[i] ? t : "<*>"));
  }

  getClusterCount(template: string[]): number {
    const joined = template.join(" ");
    return this.clusters.find((c) => c.template.join(" ") === joined)?.count ?? 1;
  }
}

const FRAMEWORK_FRAME_RE =
  /node_modules\/|java\.base\/|(webpack|vite|next|esbuild)\//;
const STACK_FRAME_RE = /^\s+at\s+/;

function compressStackTrace(lines: string[], hash: string): string[] {
  const errorLine = lines[0] ?? "";
  const frames = lines.slice(1).filter((l) => STACK_FRAME_RE.test(l));
  const meaningfulFrames = frames.filter((f) => !FRAMEWORK_FRAME_RE.test(f));
  const topFrames = meaningfulFrames.slice(0, 5);
  const droppedCount = frames.length - topFrames.length;
  const result = [errorLine, ...topFrames];
  if (droppedCount > 0) {
    result.push(`    [${droppedCount} frames omitted — retrieve(${hash}) for full trace]`);
  }
  return result;
}

const DEFAULT_POLICY: Required<LogLevelPolicy> = {
  TRACE: "drop",
  DEBUG: "sample",
  INFO: "sample",
  WARN: "keep",
  ERROR: "keep",
  FATAL: "keep",
};

const SAMPLE_RATE: Record<string, number> = {
  DEBUG: 20,
  INFO: 10,
};

/**
 * Compresses log output via ANSI stripping, timestamp normalization,
 * Drain template mining, level filtering, and stack trace compression.
 */
export function compressLog(
  content: string,
  ctx?: Partial<CompressContext>,
  opts: LogCompressOptions = {},
): CompressResult {
  const originalTokens = countTokensFast(content);
  const noop = (): CompressResult => ({
    content,
    originalTokens,
    compressedTokens: originalTokens,
    ratio: 1,
    transforms: [],
    ccrHashes: [],
    cacheHit: false,
  });

  try {
    const policy = { ...DEFAULT_POLICY, ...(opts.logLevelPolicy ?? {}) };
    const store = getDefaultCCRStore();
    const hash = store.store(content, "log", { sessionId: ctx?.sessionId });
    const appliedTransforms: string[] = ["ansi-strip"];

    // Step 1: ANSI stripping
    let lines = content.replace(ANSI_RE, "").split("\n");

    // Step 2: Timestamp normalization
    let firstTimestamp: number | null = null;
    lines = lines.map((line) => {
      let rest = line;
      let tsMs: number | null = null;

      const isoMatch = ISO_TS_RE.exec(rest);
      if (isoMatch) {
        try { tsMs = new Date(isoMatch[0]).getTime(); } catch { /* ok */ }
        rest = rest.slice(isoMatch[0].length).trimStart();
      } else if (BRACKET_TS_RE.test(rest)) {
        rest = rest.replace(BRACKET_TS_RE, "");
      } else if (UNIX_MS_RE.test(rest)) {
        const m = UNIX_MS_RE.exec(rest);
        if (m) { tsMs = parseInt(m[0]); rest = rest.slice(m[0].length); }
      } else if (RELATIVE_TS_RE.test(rest)) {
        rest = rest.replace(RELATIVE_TS_RE, "");
      }

      if (tsMs !== null) {
        if (firstTimestamp === null) {
          firstTimestamp = tsMs;
          return `[t=0] ${rest}`;
        }
        return `[+${tsMs - firstTimestamp}ms] ${rest}`;
      }
      return rest;
    });
    appliedTransforms.push("timestamp-normalize");

    // Step 3: Drain template mining + level filtering + consecutive dedup
    const drain = new DrainParser({ simThreshold: 0.5, depth: 4 });
    const levelCounts = new Map<string, number>();
    const resultLines: string[] = [];
    const seenConsecutive = new Map<string, number>();
    let lastLine = "";
    let lastCount = 1;

    // Stack trace accumulation
    let inStack = false;
    let stackLines: string[] = [];

    const flushStack = () => {
      if (stackLines.length === 0) return;
      const compressed = compressStackTrace(stackLines, hash);
      resultLines.push(...compressed);
      stackLines = [];
      inStack = false;
    };

    for (const line of lines) {
      if (!line.trim()) {
        flushStack();
        continue;
      }

      // Stack trace detection
      if (inStack) {
        if (STACK_FRAME_RE.test(line) || /^\s+\.{3}/.test(line)) {
          stackLines.push(line);
          continue;
        }
        flushStack();
      }

      const levelMatch = LEVEL_RE.exec(line);
      const level = (levelMatch?.[1]?.toUpperCase() ?? "INFO") as string;
      const normalLevel = level === "WARNING" ? "WARN" : level === "CRITICAL" || level === "EXCEPTION" ? "ERROR" : level;
      const policyKey = (normalLevel in DEFAULT_POLICY ? normalLevel : "INFO") as keyof typeof DEFAULT_POLICY;
      const action = policy[policyKey] ?? "keep";

      if (action === "drop") continue;
      if (action === "sample") {
        const rate = SAMPLE_RATE[normalLevel] ?? 10;
        levelCounts.set(normalLevel, (levelCounts.get(normalLevel) ?? 0) + 1);
        if ((levelCounts.get(normalLevel) ?? 0) % rate !== 1) continue;
      }

      // Detect start of stack trace (case-insensitive)
      const isExceptionLine = /(?:error|exception|traceback).*:/i.test(line);
      if ((normalLevel === "ERROR" || normalLevel === "FATAL") && isExceptionLine) {
        inStack = true;
        stackLines = [line];
        continue;
      }

      // Drain template mining
      const template = drain.addLogEntry(line);
      const count = drain.getClusterCount(template.split(/\s+/));

      // Consecutive duplicate collapse
      if (line === lastLine) {
        lastCount++;
        if (resultLines.length > 0) {
          resultLines[resultLines.length - 1] = `${line} [×${lastCount}]`;
        }
        continue;
      }
      lastLine = line;
      lastCount = 1;

      // Collapse repeated template lines
      const templateKey = template;
      const prevCount = seenConsecutive.get(templateKey) ?? 0;
      if (count > 1 && prevCount > 0) {
        seenConsecutive.set(templateKey, prevCount + 1);
        if (resultLines.length > 0) {
          resultLines[resultLines.length - 1] = `${template} [×${prevCount + 1}]`;
        }
        continue;
      }
      seenConsecutive.set(templateKey, 1);
      resultLines.push(line);
    }

    flushStack();
    appliedTransforms.push("drain-template", "level-filter", "stack-compress");

    const result =
      resultLines.join("\n") +
      `\n// [Log compressed. retrieve(${hash}) for full]`;

    const { compressedTokens } = estimateSavings(content, result);

    return {
      content: result,
      originalTokens,
      compressedTokens,
      ratio: originalTokens === 0 ? 1 : compressedTokens / originalTokens,
      transforms: appliedTransforms,
      ccrHashes: [hash],
      cacheHit: false,
    };
  } catch {
    return noop();
  }
}
