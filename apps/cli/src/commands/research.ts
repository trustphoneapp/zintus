import chalk from "chalk";
import {
  deepResearch,
  runFallbackSearch,
  type DeepResearchDeps,
  type ResearchDepth,
  type SearchResult,
} from "@zintus/search";
import type { ChatMessage } from "@zintus/types";
import { createAppEngine } from "../lib/router.js";
import { loadConfig } from "../lib/config.js";
import { IdleTimeoutError, withIdleTimeout } from "../lib/idle-timeout.js";

/** Abort when NO research event arrives for this long (stalled upstream). */
const RESEARCH_IDLE_MS = 120_000;

export interface ResearchOptions {
  depth?: ResearchDepth;
  json?: boolean;
}

/**
 * `zintus research <query>` — deep web research with cited sources, run via the
 * SAME engine + @zintus/search pieces the gateway's /v1/research uses (the CLI
 * runs the engine in-process, so it rebuilds the gateway's deepResearch deps
 * rather than calling HTTP). Needs a Tavily/Serper key for the search step.
 */
export async function runResearch(
  query: string,
  options: ResearchOptions = {},
): Promise<void> {
  const tavilyApiKey = process.env.TAVILY_API_KEY?.trim() || undefined;
  const serperApiKey = process.env.SERPER_API_KEY?.trim() || undefined;
  if (!tavilyApiKey && !serperApiKey) {
    console.error(
      chalk.red(
        "Deep research needs a web-search key. Set TAVILY_API_KEY or SERPER_API_KEY.",
      ),
    );
    process.exit(1);
  }

  const searchEnv = { tavilyApiKey, serperApiKey };
  const config = await loadConfig();
  const engine = createAppEngine(config);
  const depth: ResearchDepth = options.depth ?? "standard";
  const json = options.json ?? false;

  async function collectText(messages: ChatMessage[]): Promise<string> {
    const result = await engine.routeAndStream({ messages, stream: true });
    let text = "";
    for await (const chunk of result.stream) {
      text += chunk;
    }
    return text;
  }

  const deps: DeepResearchDeps = {
    decompose: async (q, count) => {
      const text = await collectText([
        {
          role: "user",
          content:
            `Break this research question into exactly ${count} focused, distinct web-search queries. ` +
            `Return ONLY a JSON array of strings, no prose.\n\nQuestion: ${q}`,
        },
      ]);
      try {
        const start = text.indexOf("[");
        const end = text.lastIndexOf("]");
        if (start !== -1 && end > start) {
          const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
          if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed.slice(0, count).map((item) => String(item));
          }
        }
      } catch {
        // fall through to single-query fallback
      }
      return [q];
    },
    search: async (q) => {
      const outcome = await runFallbackSearch(
        q,
        { enabled: true, depth: "basic", maxResults: 5 },
        searchEnv,
      );
      return outcome.results;
    },
    synthesize: async function* (q, context) {
      const result = await engine.routeAndStream({
        messages: [
          {
            role: "system",
            content:
              "You are a research assistant. Synthesize a thorough, well-structured answer " +
              "from the provided sources. Cite sources inline as [1], [2], [3].",
          },
          { role: "user", content: `Sources:\n${context}\n\nQuestion: ${q}` },
        ],
        stream: true,
      });
      for await (const chunk of result.stream) {
        yield chunk;
      }
    },
  };

  let answer = "";
  let sources: SearchResult[] = [];

  if (!json) {
    console.log(chalk.bold(`\n🔎 Researching: ${query}\n`));
  }

  try {
    // Idle watchdog: a stalled search/LLM upstream used to hang here until
    // Ctrl-C; now any 2-minute silence aborts with an honest error.
    for await (const event of withIdleTimeout(
      deepResearch(query, { depth }, deps),
      RESEARCH_IDLE_MS,
    )) {
      switch (event.type) {
        case "queries":
          if (!json) {
            console.log(chalk.dim("Plan:"));
            for (const q of event.queries) console.log(chalk.dim(`  • ${q}`));
            console.log();
          }
          break;
        case "search_complete":
          sources.push(...event.results);
          if (!json) {
            console.log(
              chalk.dim(`  searched (${event.results.length} results)…`),
            );
          }
          break;
        case "synthesizing":
          if (!json) {
            console.log(
              chalk.dim(`\nSynthesizing from ${event.sourceCount} sources…\n`),
            );
          }
          break;
        case "answer_chunk":
          answer += event.text;
          if (!json) process.stdout.write(event.text);
          break;
        case "done":
          if (event.sources.length) sources = event.sources;
          break;
        case "error":
          console.error(chalk.red(`\nResearch error: ${event.message}`));
          process.exit(1);
      }
    }
  } catch (error) {
    const label = error instanceof IdleTimeoutError ? "Research stalled" : "Research failed";
    console.error(
      chalk.red(
        `\n${label}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    process.exit(1);
  }

  if (json) {
    console.log(JSON.stringify({ query, answer, sources }, null, 2));
    return;
  }

  if (sources.length > 0) {
    console.log(chalk.bold("\n\nSources:"));
    sources.forEach((s, i) => {
      console.log(`  ${chalk.cyan(`[${i + 1}]`)} ${s.title || s.url}`);
      console.log(`      ${chalk.dim(s.url)}`);
    });
  }
  console.log();
}
