import { describe, test, expect } from "bun:test";
import {
  getSpeechRecognitionCtor,
  collectTranscript,
  appendDictation,
  describeSpeechError,
  type SpeechRecognitionCtor,
  type SpeechRecognitionEventLike,
  type SpeechResultLike,
} from "./use-speech-recognition";

// ── A mock recognizer + window, so feature detection is exercised without DOM ──
class MockSpeechRecognition {
  lang = "";
  continuous = false;
  interimResults = false;
  start(): void {}
  stop(): void {}
  abort(): void {}
  onresult: ((e: SpeechRecognitionEventLike) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  onstart: (() => void) | null = null;
}
const MockCtor = MockSpeechRecognition as unknown as SpeechRecognitionCtor;

/** Build a recognition event from [text, isFinal] pairs at a given resultIndex. */
function event(
  resultIndex: number,
  pairs: Array<[string, boolean]>,
): SpeechRecognitionEventLike {
  const results = pairs.map(
    ([transcript, isFinal]): SpeechResultLike => ({
      0: { transcript },
      isFinal,
      length: 1,
    }),
  );
  return { resultIndex, results };
}

describe("getSpeechRecognitionCtor — feature detection", () => {
  test("returns the standard constructor when present", () => {
    expect(getSpeechRecognitionCtor({ SpeechRecognition: MockCtor })).toBe(
      MockCtor,
    );
  });

  test("falls back to the webkit-prefixed constructor", () => {
    expect(
      getSpeechRecognitionCtor({ webkitSpeechRecognition: MockCtor }),
    ).toBe(MockCtor);
  });

  test("prefers the standard name over the prefix", () => {
    const Std = class extends MockSpeechRecognition {} as unknown as SpeechRecognitionCtor;
    expect(
      getSpeechRecognitionCtor({
        SpeechRecognition: Std,
        webkitSpeechRecognition: MockCtor,
      }),
    ).toBe(Std);
  });

  test("returns null when neither exists (e.g. Firefox/Safari) or off-DOM", () => {
    expect(getSpeechRecognitionCtor({})).toBeNull();
    expect(getSpeechRecognitionCtor(undefined)).toBeNull();
  });
});

describe("collectTranscript — interim vs final accumulation", () => {
  test("separates final from interim text", () => {
    const { final, interim } = collectTranscript(
      event(0, [
        ["hello ", true],
        ["wor", false],
      ]),
    );
    expect(final).toBe("hello ");
    expect(interim).toBe("wor");
  });

  test("only scans from resultIndex, never re-counting earlier finals", () => {
    // Two earlier finalized results exist but resultIndex points past them.
    const { final, interim } = collectTranscript(
      event(2, [
        ["already ", true],
        ["committed ", true],
        ["new chunk", true],
        ["typing", false],
      ]),
    );
    expect(final).toBe("new chunk");
    expect(interim).toBe("typing");
  });

  test("accumulating final chunks across events builds the full transcript", () => {
    let composed = "";
    // Continuous mode grows the results array; resultIndex marks the new tail.
    const events = [
      event(0, [["the quick ", true]]),
      event(1, [
        ["the quick ", true],
        ["brown fox", true],
      ]),
    ];
    for (const e of events) {
      const { final } = collectTranscript(e);
      composed = appendDictation(composed, final);
    }
    expect(composed).toBe("the quick brown fox");
  });

  test("tolerates empty results", () => {
    expect(collectTranscript(event(0, []))).toEqual({ final: "", interim: "" });
  });
});

describe("appendDictation — spacing into the composer", () => {
  test("joins two words with a single space", () => {
    expect(appendDictation("hello", "world")).toBe("hello world");
  });

  test("does not double a space when the base already ends in whitespace", () => {
    expect(appendDictation("hello ", "world")).toBe("hello world");
  });

  test("returns the chunk alone when the base is empty", () => {
    expect(appendDictation("", "world")).toBe("world");
  });

  test("ignores an empty/whitespace chunk", () => {
    expect(appendDictation("hello", "   ")).toBe("hello");
  });
});

describe("describeSpeechError — calm, humanized notices", () => {
  test("denied permission yields a clear, actionable message", () => {
    expect(describeSpeechError("not-allowed")).toContain("blocked");
    expect(describeSpeechError("service-not-allowed")).toContain("blocked");
  });

  test("no-speech and audio-capture are explained, not raw codes", () => {
    expect(describeSpeechError("no-speech")).toContain("speaking");
    expect(describeSpeechError("audio-capture")).toContain("microphone");
  });

  test("a programmatic abort is silent (no notice)", () => {
    expect(describeSpeechError("aborted")).toBe("");
  });

  test("unknown codes get a calm fallback, never the raw code", () => {
    expect(describeSpeechError("some-future-code")).not.toContain(
      "some-future-code",
    );
    expect(describeSpeechError("some-future-code").length).toBeGreaterThan(0);
  });
});
