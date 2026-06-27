import { describe, expect, test } from "bun:test";
import { textOf } from "@zintus/types";
import type {
  MemoryChunkHit,
  MemoryFact,
  MemoryStore,
  MemoryThreadState,
  ThreadMessage,
} from "@zintus/types";
import { compileContext } from "./compiler.js";

class StubMemoryStore implements MemoryStore {
  constructor(
    private readonly state: MemoryThreadState | null,
    private readonly facts: MemoryFact[],
    private readonly chunks: MemoryChunkHit[] = [],
  ) {}

  async getThreadState(_threadId: string): Promise<MemoryThreadState | null> {
    return this.state;
  }

  async getTopFacts(
    _threadId: string,
    _query: string,
    limit: number,
  ): Promise<MemoryFact[]> {
    return this.facts.slice(0, limit);
  }

  async searchChunks(
    _threadId: string,
    _query: string,
    topK = 5,
  ): Promise<MemoryChunkHit[]> {
    return this.chunks.slice(0, topK);
  }
}

function message(
  role: ThreadMessage["role"],
  content: string,
  id: string,
): ThreadMessage {
  return {
    id,
    threadId: "thread-1",
    role,
    content,
    createdAt: new Date(),
  };
}

describe("compileContext", () => {
  test("fast mode keeps minimal prompt plus user message", async () => {
    const memory = new StubMemoryStore(null, []);
    const episodic: ThreadMessage[] = [
      message("user", "Earlier question", "1"),
      message("assistant", "Earlier answer", "2"),
    ];

    const result = await compileContext({
      threadId: "thread-1",
      newUserMessage: "New question",
      mode: "fast",
      memory,
      episodicMessages: episodic,
      contextWindow: 8000,
    });

    expect(result.messages.at(0)?.role).toBe("system");
    expect(result.messages.at(-1)).toEqual({
      role: "user",
      content: "New question",
    });
    expect(result.compileTrace.mode).toBe("fast");
    expect(result.compileTrace.includedSections).toContain("minimal-system");
    expect(result.compileTrace.includedSections).not.toContain("working-summary");
    expect(result.compileTrace.retrievedChunkCount).toBe(0);
  });

  test("smart mode includes summary, recent turns, facts and handoff", async () => {
    const memory = new StubMemoryStore(
      {
        threadId: "thread-1",
        workingSummary: "User is building a context compiler package.",
        constraints: ["Use bun test"],
        userPreferences: ["Concise explanations"],
      },
      [
        { id: "fact-1", content: "Repo uses workspace packages." },
        { id: "fact-2", content: "Engine stores thread messages." },
      ],
      [
        {
          id: "chunk-1",
          content: "The vector retrieval flow surfaces semantically similar memory chunks.",
          relevance: 0.91,
        },
      ],
    );

    const episodic: ThreadMessage[] = [
      message("user", "Question one", "1"),
      message("assistant", "Answer one", "2"),
      message("user", "Question two", "3"),
      message("assistant", "Answer two", "4"),
      message("user", "Question three", "5"),
      message("assistant", "Answer three", "6"),
    ];

    const result = await compileContext({
      threadId: "thread-1",
      newUserMessage: "Please compile context smartly.",
      mode: "smart",
      targetModel: "gpt-5",
      lastModel: "claude-sonnet",
      memory,
      episodicMessages: episodic,
      contextWindow: 12000,
    });

    const systemBlocks = result.messages.filter((message) => message.role === "system");
    expect(systemBlocks.some((message) => textOf(message.content).includes("Working summary:")))
      .toBe(true);
    expect(systemBlocks.some((message) => textOf(message.content).includes("Top facts:"))).toBe(
      true,
    );
    expect(
      systemBlocks.some((message) => textOf(message.content).includes("[RETRIEVED_MEMORY]")),
    ).toBe(true);
    expect(
      systemBlocks.some((message) => textOf(message.content).includes("System handoff context:")),
    ).toBe(true);
    expect(result.compileTrace.mode).toBe("smart");
    expect(result.compileTrace.selectedTurnCount).toBe(3);
    expect(result.compileTrace.retrievedChunkCount).toBe(1);
    expect(result.bundle.targetModel).toBe("gpt-5");
    expect(result.bundle.retrievedChunks).toHaveLength(1);
  });
});
