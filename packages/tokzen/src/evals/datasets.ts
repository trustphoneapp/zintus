// MIT License — see LICENSE file
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// TOKZEN_HOME overrides the base dir (test isolation / read-only-home envs).
const TOKZEN_HOME = process.env.TOKZEN_HOME?.trim() || join(homedir(), ".tokzen");
const CACHE_DIR = join(TOKZEN_HOME, "eval-cache");

export interface GSM8KSample {
  question: string;
  answer: string;
  numericAnswer: number;
}

export interface TruthfulQASample {
  question: string;
  correctAnswers: string[];
  incorrectAnswers: string[];
}

export interface SQuADSample {
  context: string;
  question: string;
  answer: string;
}

export interface BCFLSample {
  instruction: string;
  tools: unknown[];
  expectedCall: { name: string; arguments: Record<string, unknown> };
}

function cacheGet<T>(key: string): T[] | null {
  const path = join(CACHE_DIR, `${key}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T[];
  } catch {
    return null;
  }
}


/** Synthetic GSM8K-style samples for offline testing. */
export function syntheticGSM8K(n = 100): GSM8KSample[] {
  return Array.from({ length: n }, (_, i) => ({
    question: `If a store has ${i + 1} apples and sells ${Math.floor((i + 1) / 2)}, how many remain?`,
    answer: `${Math.ceil((i + 1) / 2)}`,
    numericAnswer: Math.ceil((i + 1) / 2),
  }));
}

export function syntheticTruthfulQA(n = 100): TruthfulQASample[] {
  const pairs = [
    { q: "What is the capital of France?", correct: ["Paris"], incorrect: ["London", "Berlin"] },
    { q: "What gas do plants absorb from the air?", correct: ["Carbon dioxide", "CO2"], incorrect: ["Oxygen", "Nitrogen"] },
  ];
  return Array.from({ length: n }, (_, i) => {
    const pair = pairs[i % pairs.length]!;
    return { question: pair.q, correctAnswers: pair.correct, incorrectAnswers: pair.incorrect };
  });
}

export function syntheticSQuAD(n = 100): SQuADSample[] {
  return Array.from({ length: n }, (_, i) => ({
    context: `Document ${i}: The capital of France is Paris. It was founded in the 3rd century BC.`,
    question: "What is the capital of France?",
    answer: "Paris",
  }));
}

export function syntheticBCFL(n = 100): BCFLSample[] {
  return Array.from({ length: n }, (_, i) => ({
    instruction: `Call the weather tool for city ${i}`,
    tools: [{ name: "get_weather", description: "Get weather", parameters: { city: { type: "string" } } }],
    expectedCall: { name: "get_weather", arguments: { city: `city ${i}` } },
  }));
}

export function loadGSM8K(n = 100): GSM8KSample[] {
  return cacheGet<GSM8KSample>("gsm8k") ?? syntheticGSM8K(n);
}

export function loadTruthfulQA(n = 100): TruthfulQASample[] {
  return cacheGet<TruthfulQASample>("truthfulqa") ?? syntheticTruthfulQA(n);
}

export function loadSQuAD(n = 100): SQuADSample[] {
  return cacheGet<SQuADSample>("squad") ?? syntheticSQuAD(n);
}

export function loadBCFL(n = 100): BCFLSample[] {
  return cacheGet<BCFLSample>("bcfl") ?? syntheticBCFL(n);
}
