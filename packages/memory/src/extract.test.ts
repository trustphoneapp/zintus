import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@zintus/types";
import { extractFacts } from "./extract.js";

const user = (content: string): ChatMessage[] => [{ role: "user", content }];

const constraintsOf = (content: string): string[] =>
  extractFacts(user(content))
    .filter((fact) => fact.id.startsWith("constraint"))
    .map((fact) => fact.content);

const hasConstraint = (content: string, re: RegExp): boolean =>
  constraintsOf(content).some((value) => re.test(value));

describe("extractFacts — rejects conversational noise", () => {
  // The bug from audit P1-2: casual first-person "can't" chatter became a
  // persistent constraint fact injected into all future context.
  const garbage = [
    "I can't believe this works",
    "I can't believe this actually works!",
    "I can't wait to see this",
    "you can't be serious",
    "can't stop laughing",
    "I can't even with this code",
    "don't worry about it, it's fine",
    "I always wanted to learn piano",
    "I never thought this would happen",
  ];

  for (const text of garbage) {
    test(`no constraint from: "${text}"`, () => {
      expect(constraintsOf(text)).toEqual([]);
    });
  }

  test("questions never produce facts", () => {
    expect(extractFacts(user("Should I never use the any type?"))).toEqual([]);
    expect(extractFacts(user("Can you always cite your sources?"))).toEqual([]);
    expect(extractFacts(user("Why can't I get this to work?"))).toEqual([]);
  });

  test("bare fragments / verb-only directives are dropped (min-signal floor)", () => {
    expect(constraintsOf("I must go")).toEqual([]);
    expect(constraintsOf("can't.")).toEqual([]);
    expect(constraintsOf("we should stop")).toEqual([]);
  });

  test("a casual sentence next to a real rule keeps only the rule", () => {
    const facts = extractFacts(user("I can't believe this works! Always cite your sources."));
    const constraints = facts.filter((f) => f.id.startsWith("constraint")).map((f) => f.content);
    expect(constraints.some((c) => /believe/i.test(c))).toBe(false);
    expect(constraints.some((c) => /always cite your sources/i.test(c))).toBe(true);
  });
});

describe("extractFacts — still captures real constraints & preferences", () => {
  test("assistant-directed rule keeps its negation", () => {
    // Old regex captured only the tail ("use ... any"), inverting the meaning.
    expect(hasConstraint("you must not use TypeScript any", /^must not use typescript any/i)).toBe(
      true,
    );
  });

  test("imperative always/never directives", () => {
    expect(hasConstraint("always cite sources", /^always cite sources$/i)).toBe(true);
    expect(hasConstraint("never use the any type", /^never use the any type$/i)).toBe(true);
  });

  test("stated user limitation about themselves", () => {
    expect(hasConstraint("I can't read code, explain in plain English", /can't read code/i)).toBe(
      true,
    );
  });

  test("'must be' style rules are kept (reaction guard is can't-only)", () => {
    expect(hasConstraint("output must be valid JSON", /must be valid json/i)).toBe(true);
    expect(hasConstraint("you should not run migrations on Fridays", /should not run migrations/i)).toBe(
      true,
    );
  });

  test("preferences are still extracted", () => {
    const prefs = extractFacts(user("I prefer dark mode and concise answers."));
    expect(prefs.some((f) => f.id.startsWith("preference"))).toBe(true);
  });

  test("captured constraints carry the expected fact schema", () => {
    const facts = extractFacts(user("never use the any type"));
    const constraint = facts.find((f) => f.id.startsWith("constraint"));
    expect(constraint).toBeDefined();
    expect(constraint?.source).toBe("heuristic");
    expect(typeof constraint?.relevance).toBe("number");
    expect(constraint?.id.startsWith("constraint.")).toBe(true);
  });

  test("dedupes repeated constraints across turns", () => {
    const turns: ChatMessage[] = [
      { role: "user", content: "always cite sources" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "always cite sources" },
    ];
    const constraints = extractFacts(turns).filter((f) => f.id.startsWith("constraint"));
    expect(constraints).toHaveLength(1);
  });
});
