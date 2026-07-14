// Tool auto-suggest chips — pure client-side intent detection.
//
// Zero model calls, zero silent spend: this module only pattern-matches the
// composer text and returns a suggestion the user can accept or dismiss. It
// never enables a tool by itself — the caller (the chat page) always routes
// through an explicit user tap, and the cost is disclosed in the copy before
// that tap happens.

export type ToolSuggestKind = "search" | "json" | "research";

export interface ToolSuggestState {
  searchOn: boolean;
  researchOn: boolean;
  /** The composer's current structured-output mode ("off" | "json_object" | "json_schema"). */
  jsonMode: string;
  dismissed: Set<ToolSuggestKind>;
}

export interface ToolSuggestion {
  kind: ToolSuggestKind;
  label: string;
  costHint: string;
}

const SEARCH_RE =
  /\b(latest|today|current(ly)?|news|price of|stock|weather|score|who won|as of|right now|this week|this month|20(2[5-9]|3\d))\b/i;
const JSON_RE = /\b(json|schema|structured output)\b/i;
const RESEARCH_RE =
  /\b(deep dive|in.?depth|thorough(ly)?|research this|write a report|compare\b.{0,40}\b(options|providers|tools|approaches))\b/i;

const RESEARCH_MIN_LENGTH = 80;

const COPY: Record<ToolSuggestKind, { label: string; costHint: string }> = {
  search: { label: "Looks like this needs current info", costHint: "+~2K tok" },
  json: { label: "Want structured JSON output?", costHint: "no extra cost" },
  research: {
    label: "This could use deep research",
    costHint: "multi-step · higher token use",
  },
};

/**
 * Pure resolver: given the composer text and current toggle/dismiss state,
 * returns at most one suggestion. Priority when multiple heuristics match:
 * search > json > research. A dismissed kind never re-suggests until the
 * caller clears its dismissed set (e.g. a new session).
 */
export function suggestTool(
  text: string,
  state: ToolSuggestState,
): ToolSuggestion | null {
  if (!text || !text.trim()) return null;

  if (
    !state.searchOn &&
    !state.dismissed.has("search") &&
    SEARCH_RE.test(text)
  ) {
    return { kind: "search", ...COPY.search };
  }

  if (
    state.jsonMode === "off" &&
    !state.dismissed.has("json") &&
    JSON_RE.test(text)
  ) {
    return { kind: "json", ...COPY.json };
  }

  if (
    !state.researchOn &&
    !state.dismissed.has("research") &&
    text.length > RESEARCH_MIN_LENGTH &&
    RESEARCH_RE.test(text)
  ) {
    return { kind: "research", ...COPY.research };
  }

  return null;
}

// ── Acceptance logging (localStorage only, no network) ─────────────────────

export type ToolSuggestStatEvent = "shown" | "accepted" | "dismissed";

export type ToolSuggestStats = Record<
  ToolSuggestKind,
  { shown: number; accepted: number; dismissed: number }
>;

const STATS_KEY = "zintus:tool-suggest-stats";

function emptyStats(): ToolSuggestStats {
  return {
    search: { shown: 0, accepted: 0, dismissed: 0 },
    json: { shown: 0, accepted: 0, dismissed: 0 },
    research: { shown: 0, accepted: 0, dismissed: 0 },
  };
}

export function readToolSuggestStats(): ToolSuggestStats {
  if (typeof localStorage === "undefined") return emptyStats();
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (!raw) return emptyStats();
    const parsed = JSON.parse(raw) as Partial<ToolSuggestStats>;
    const base = emptyStats();
    return {
      search: { ...base.search, ...parsed.search },
      json: { ...base.json, ...parsed.json },
      research: { ...base.research, ...parsed.research },
    };
  } catch {
    return emptyStats();
  }
}

/** Increments one counter for one kind. Best-effort — never throws. */
export function recordToolSuggestEvent(
  kind: ToolSuggestKind,
  event: ToolSuggestStatEvent,
): void {
  if (typeof localStorage === "undefined") return;
  const stats = readToolSuggestStats();
  stats[kind][event] += 1;
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(stats));
  } catch {
    // Storage full/unavailable — logging is best-effort only.
  }
}
