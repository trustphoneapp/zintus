import { describe, expect, test } from "bun:test";
import {
  extractArtifacts,
  extractArtifactsCached,
  extractConversationArtifacts,
  artifactTotalCost,
  estimateRebakeCostUsd,
  lineDiff,
  diffStats,
  isLikelyComplete,
  buildArtifactTag,
  buildArtifactRefeed,
  parseArtifactTag,
  summarizeArtifactBody,
  artifactExtension,
  artifactMime,
  artifactIdentity,
  upsertArtifactVersion,
  artifactAtVersion,
  foldArtifactVersions,
  type Artifact,
} from "./artifacts";

const bigCode = [
  "Here is a helper:",
  "",
  "```python",
  "# fibonacci sequence",
  "def fib(n):",
  "    a, b = 0, 1",
  "    out = []",
  "    for _ in range(n):",
  "        out.append(a)",
  "        a, b = b, a + b",
  "    return out",
  "",
  "print(fib(1))",
  "print(fib(2))",
  "print(fib(3))",
  "print(fib(4))",
  "print(fib(5))",
  "print(fib(6))",
  "print(fib(7))",
  "print(fib(8))",
  "```",
  "",
  "That returns the first n numbers.",
].join("\n");

const htmlDoc = [
  "A landing page:",
  "",
  "```html",
  "<!DOCTYPE html>",
  "<html>",
  "  <head><title>My Page</title></head>",
  "  <body><h1>Hello</h1></body>",
  "</html>",
  "```",
].join("\n");

const svgDoc = [
  "An icon:",
  "",
  "```svg",
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">',
  '  <circle cx="12" cy="12" r="10" fill="violet" />',
  "</svg>",
  "```",
].join("\n");

const longMarkdown = [
  "# Project plan",
  "",
  "An overview of the work ahead, in three phases.",
  "",
  "## Phase one",
  "",
  "Set up the repository and the build pipeline.",
  "Wire continuous integration so every push runs the tests.",
  "",
  "## Phase two",
  "",
  "Implement the core features and write unit tests.",
  "Each module ships behind a flag until it is reviewed.",
  "",
  "## Phase three",
  "",
  "Polish, document, and prepare the release notes.",
  "Cut a candidate and run the full regression suite.",
].join("\n");

const tinySnippet = "Use this:\n\n```js\nconst x = 1;\nconsole.log(x);\n```";

describe("extractArtifacts", () => {
  test("detects a large code block with language + derived title", () => {
    const arts = extractArtifacts(bigCode);
    expect(arts).toHaveLength(1);
    expect(arts[0]).toMatchObject({ kind: "code", language: "python" });
    expect(arts[0]!.title).toBe("fibonacci sequence");
    expect(arts[0]!.content).toContain("def fib(n):");
  });

  test("detects a full HTML document and reads its <title>", () => {
    const arts = extractArtifacts(htmlDoc);
    expect(arts).toHaveLength(1);
    expect(arts[0]).toMatchObject({ kind: "html", title: "My Page" });
    expect(artifactExtension(arts[0]!)).toBe("html");
    expect(artifactMime(arts[0]!)).toBe("text/html");
  });

  test("detects an SVG image", () => {
    const arts = extractArtifacts(svgDoc);
    expect(arts).toHaveLength(1);
    expect(arts[0]).toMatchObject({ kind: "svg", title: "SVG image" });
    expect(arts[0]!.content).toContain("<circle");
    expect(artifactMime(arts[0]!)).toBe("image/svg+xml");
  });

  test("detects a raw (un-fenced) SVG", () => {
    const arts = extractArtifacts(
      'Here:\n<svg width="10" height="10"><rect/></svg>\ndone',
    );
    expect(arts.some((a) => a.kind === "svg")).toBe(true);
  });

  test("detects a long markdown document", () => {
    const arts = extractArtifacts(longMarkdown);
    expect(arts).toHaveLength(1);
    expect(arts[0]).toMatchObject({ kind: "markdown", title: "Project plan" });
    expect(arts[0]!.content).toContain("## Phase three");
  });

  test("does NOT extract a tiny 2-line snippet", () => {
    expect(extractArtifacts(tinySnippet)).toEqual([]);
  });

  test("returns [] for empty / whitespace / no-artifact input", () => {
    expect(extractArtifacts("")).toEqual([]);
    expect(extractArtifacts("   \n  ")).toEqual([]);
    expect(extractArtifacts("Just a normal sentence, nothing to extract.")).toEqual(
      [],
    );
  });

  test("ids are stable across calls and unique within a message", () => {
    const a1 = extractArtifacts(bigCode + "\n\n" + svgDoc);
    const a2 = extractArtifacts(bigCode + "\n\n" + svgDoc);
    expect(a1.map((a) => a.id)).toEqual(a2.map((a) => a.id));
    expect(new Set(a1.map((a) => a.id)).size).toBe(a1.length);
    expect(a1.length).toBeGreaterThanOrEqual(2);
  });
});

describe("model-declared artifacts (tagged)", () => {
  const taggedConfig = [
    "Here's the config:",
    "",
    '```artifact id="db-config" title="Database config" type="code" lang="yaml"',
    "host: localhost",
    "port: 5432",
    "user: app",
    "pool: 10",
    "ssl: true",
    "```",
  ].join("\n");

  test("parseArtifactTag reads attributes and rejects ordinary fences", () => {
    expect(parseArtifactTag('artifact id="a" title="T" type="code" lang="ts"')).toMatchObject({
      id: "a",
      title: "T",
      type: "code",
      language: "ts",
    });
    expect(parseArtifactTag("python")).toBeNull();
    expect(parseArtifactTag("")).toBeNull();
    // unknown type is dropped (kind inferred later), id/title still parsed
    expect(parseArtifactTag('artifact id="x" type="bogus"')).toMatchObject({ id: "x", type: undefined });
  });

  test("a tagged block is an artifact even BELOW the size heuristic", () => {
    const arts = extractArtifacts(taggedConfig);
    expect(arts).toHaveLength(1);
    expect(arts[0]).toMatchObject({
      kind: "code",
      language: "yaml",
      title: "Database config",
      declaredId: "db-config",
    });
    expect(arts[0]!.content).toContain("port: 5432");
  });

  test("an untagged incidental block still falls back to the heuristic", () => {
    // 2-line untagged snippet → NOT extracted (below threshold)
    expect(extractArtifacts(tinySnippet)).toEqual([]);
    // 16-line untagged snippet → extracted by the size heuristic, no declaredId
    const sixteen = [
      "```js",
      ...Array.from({ length: 16 }, (_, i) => `const x${i} = ${i};`),
      "```",
    ].join("\n");
    const arts = extractArtifacts(sixteen);
    expect(arts).toHaveLength(1);
    expect(arts[0]).toMatchObject({ kind: "code" });
    expect(arts[0]!.declaredId).toBeUndefined();
  });

  test("tagged HTML honours type + title from the tag", () => {
    const t = ['```artifact id="lp" title="Landing" type="html"', "<div>hi</div>", "```"].join("\n");
    const arts = extractArtifacts(t);
    expect(arts).toHaveLength(1);
    expect(arts[0]).toMatchObject({ kind: "html", title: "Landing", declaredId: "lp" });
  });

  test("tagged + untagged blocks coexist in one message", () => {
    const mixed = `${taggedConfig}\n\n${bigCode}`;
    const arts = extractArtifacts(mixed);
    expect(arts).toHaveLength(2);
    expect(arts[0]!.declaredId).toBe("db-config");
    expect(arts[1]!.declaredId).toBeUndefined(); // the heuristic python block
  });
});

describe("per-message cache + streaming (goal 3)", () => {
  test("perf: a cache hit returns the SAME array — no re-parse of unchanged content", () => {
    const cache = new Map();
    const first = extractArtifactsCached("m1", bigCode, cache);
    const second = extractArtifactsCached("m1", bigCode, cache);
    expect(second).toBe(first); // same instance ⇒ extractArtifacts was NOT called again
    const changed = extractArtifactsCached("m1", `${bigCode}\nprint(fib(9))`, cache);
    expect(changed).not.toBe(first); // content changed ⇒ re-parsed
  });

  test("perf: extracting a 50-message convo re-parses only the changed message", () => {
    const cache = new Map();
    const msgs = Array.from({ length: 50 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: i === 49 ? bigCode : `reply ${i}`,
    }));
    extractConversationArtifacts(msgs, cache); // prime the cache
    // Snapshot the cached array instances for every assistant message.
    const before = new Map([...cache].map(([k, v]) => [k, v.artifacts]));
    // Mutate ONLY the last assistant message; re-run.
    msgs[49] = { id: "m49", role: "assistant", content: `${bigCode}\nprint(fib(9))` };
    extractConversationArtifacts(msgs, cache);
    for (const [k, arts] of before) {
      if (k === "m49") {
        expect(cache.get(k)!.artifacts).not.toBe(arts); // re-parsed
      } else {
        expect(cache.get(k)!.artifacts).toBe(arts); // untouched — same instance
      }
    }
  });

  test("isLikelyComplete: open fence ⇒ incomplete, closed ⇒ complete", () => {
    expect(isLikelyComplete("text ```ts\nconst x = 1;")).toBe(false);
    expect(isLikelyComplete("text ```ts\nconst x = 1;\n```")).toBe(true);
    expect(isLikelyComplete("no fences at all")).toBe(true);
  });

  test("streaming message is held back until its fence closes", () => {
    const cache = new Map();
    const open = bigCode.slice(0, bigCode.lastIndexOf("```")); // drop the closing fence
    const mid = extractConversationArtifacts(
      [{ id: "a", role: "assistant", content: open }],
      cache,
      { streamingId: "a" },
    );
    expect(mid.flat).toHaveLength(0); // not surfaced while the fence is open

    const done = extractConversationArtifacts(
      [{ id: "a", role: "assistant", content: bigCode }],
      cache,
      { streamingId: "a" },
    );
    expect(done.flat).toHaveLength(1); // surfaced once complete
    expect(done.flat[0]!.id).toBe("a:" + extractArtifacts(bigCode)[0]!.id);
  });
});

describe("summarizeArtifactBody", () => {
  test("replaces an extracted code block with a one-line reference", () => {
    const arts = extractArtifacts(bigCode);
    const body = summarizeArtifactBody(bigCode, arts);
    expect(body).not.toContain("def fib(n):");
    expect(body).toContain("artifacts panel");
    // surrounding prose is preserved
    expect(body).toContain("That returns the first n numbers.");
  });

  test("leaves a markdown-document artifact body untouched", () => {
    const arts = extractArtifacts(longMarkdown);
    expect(summarizeArtifactBody(longMarkdown, arts)).toBe(longMarkdown);
  });

  test("no-op when there are no block artifacts", () => {
    expect(summarizeArtifactBody("plain text", [])).toBe("plain text");
  });
});

describe("re-bake estimate (feature #2)", () => {
  test("a free model (rate 0) estimates $0", () => {
    expect(estimateRebakeCostUsd("anything", 0)).toBe(0);
  });

  test("estimate rises with price and with content size; deterministic", () => {
    const body = "x".repeat(4000); // ~1000 tok + overhead
    const cheap = estimateRebakeCostUsd(body, 0.14);
    const dear = estimateRebakeCostUsd(body, 3.0);
    expect(dear).toBeGreaterThan(cheap);
    expect(estimateRebakeCostUsd(body, 3.0)).toBe(dear); // deterministic
    expect(estimateRebakeCostUsd("x".repeat(8000), 3.0)).toBeGreaterThan(dear); // bigger body
  });

  test("a negative/garbage rate clamps to a non-negative estimate", () => {
    expect(estimateRebakeCostUsd("x", -5)).toBe(0);
  });
});

describe("line diff (feature #3)", () => {
  test("identical text is all 'same'", () => {
    const ops = lineDiff("a\nb\nc", "a\nb\nc");
    expect(ops.every((o) => o.type === "same")).toBe(true);
    expect(diffStats(ops)).toEqual({ added: 0, removed: 0 });
  });

  test("a changed line shows as del + add; surrounding lines stay 'same'", () => {
    const ops = lineDiff("a\nb\nc", "a\nB\nc");
    expect(diffStats(ops)).toEqual({ added: 1, removed: 1 });
    expect(ops.find((o) => o.type === "del")!.text).toBe("b");
    expect(ops.find((o) => o.type === "add")!.text).toBe("B");
    // first and last lines preserved as context
    expect(ops[0]).toEqual({ type: "same", text: "a" });
    expect(ops.at(-1)).toEqual({ type: "same", text: "c" });
  });

  test("pure insertion and pure deletion", () => {
    expect(diffStats(lineDiff("a\nc", "a\nb\nc"))).toEqual({ added: 1, removed: 0 });
    expect(diffStats(lineDiff("a\nb\nc", "a\nc"))).toEqual({ added: 0, removed: 1 });
  });

  test("reconstruction: applying the ops to `before` yields `after`", () => {
    const before = "one\ntwo\nthree\nfour";
    const after = "one\nTWO\nthree\nfive\nfour";
    const out = lineDiff(before, after)
      .filter((o) => o.type !== "del")
      .map((o) => o.text)
      .join("\n");
    expect(out).toBe(after);
  });
});

describe("provenance + cost-per-version (feature #1)", () => {
  test("fold carries model/provider/cost from the producing turn onto the version", () => {
    const cache = new Map();
    const msgs = [
      {
        id: "m1",
        role: "assistant",
        content: bigCode,
        meta: { model: "deepseek-v4-flash", provider: "deepseek", costUsd: 0.00012 },
      },
    ];
    const { flat } = extractConversationArtifacts(msgs, cache);
    const folded = foldArtifactVersions(flat);
    expect(folded[0]!.versions[0]!.model).toBe("deepseek-v4-flash");
    expect(folded[0]!.versions[0]!.provider).toBe("deepseek");
    expect(folded[0]!.versions[0]!.costUsd).toBeCloseTo(0.00012);
  });

  test("artifactTotalCost sums model versions; user edits are free", () => {
    let a = upsertArtifactVersion(null, {
      kind: "code",
      title: "X",
      content: "v1",
      model: "deepseek",
      costUsd: 0.001,
    });
    a = upsertArtifactVersion(a, { kind: "code", title: "X", content: "v2", model: "claude", costUsd: 0.04 });
    a = upsertArtifactVersion(a, { kind: "code", title: "X", content: "v3 hand-edited" }, { source: "user-edit" });
    expect(a.versions).toHaveLength(3);
    expect(artifactTotalCost(a)).toBeCloseTo(0.041); // 0.001 + 0.04 + 0 (user edit)
  });
});

describe("re-feed (goal 4)", () => {
  test("buildArtifactTag round-trips through extractArtifacts, carrying the declared id", () => {
    const block = buildArtifactTag({
      kind: "code",
      title: "Add helper",
      content: "export const add = (a, b) => a + b;",
      language: "ts",
      declaredId: "add-fn",
    });
    const arts = extractArtifacts(block);
    expect(arts).toHaveLength(1);
    expect(arts[0]).toMatchObject({
      kind: "code",
      title: "Add helper",
      language: "ts",
      declaredId: "add-fn",
    });
    expect(arts[0]!.content).toContain("=> a + b;");
  });

  test("buildArtifactTag falls back to the folded id when there's no declared id", () => {
    const block = buildArtifactTag({ kind: "html", title: "Page", content: "<div>hi</div>", id: "sim:html:abc" });
    expect(block).toContain('id="sim:html:abc"');
    expect(extractArtifacts(block)[0]).toMatchObject({ kind: "html", declaredId: "sim:html:abc" });
  });

  test("buildArtifactRefeed wraps the current version as plain user content", () => {
    const msg = buildArtifactRefeed({ kind: "code", title: "Widget", content: "x", declaredId: "w" });
    expect(msg).toContain("apply my next request to THIS version");
    expect(msg).toContain("```artifact");
    // the embedded block is itself extractable
    expect(extractArtifacts(msg)).toHaveLength(1);
  });
});

describe("iterative artifacts — versioning", () => {
  const make = (over: Partial<Artifact> = {}): Artifact => ({
    id: "x",
    kind: "code",
    language: "python",
    title: "fibonacci sequence",
    content: "def fib(n): return n",
    ...over,
  });

  test("artifactIdentity is content-free (same kind+title ⇒ same identity)", () => {
    const a = make({ content: "v1 body" });
    const b = make({ content: "totally different body" });
    expect(artifactIdentity(a)).toBe(artifactIdentity(b));
    // Different kind or title ⇒ different identity.
    expect(artifactIdentity(make({ kind: "markdown" }))).not.toBe(artifactIdentity(a));
    expect(artifactIdentity(make({ title: "Other" }))).not.toBe(artifactIdentity(a));
  });

  test("upsert seeds v1, then appends a re-emitted body as a new version", () => {
    const v1 = upsertArtifactVersion(null, make({ id: "m1", content: "body 1" }));
    expect(v1.versions).toHaveLength(1);
    expect(v1.versions[0]!.label).toBe("v1");
    expect(v1.versions[0]!.source).toBe("model");

    const v2 = upsertArtifactVersion(v1, make({ id: "m2", content: "body 2" }));
    expect(v2.versions).toHaveLength(2);
    expect(v2.versions[1]!.label).toBe("v2");
    expect(v2.id).toBe(v1.id); // stable identity, not a brand-new artifact
  });

  test("re-emitting an IDENTICAL body does NOT duplicate a version", () => {
    const v1 = upsertArtifactVersion(null, make({ id: "m1", content: "same" }));
    const again = upsertArtifactVersion(v1, make({ id: "m2", content: "same" }));
    expect(again.versions).toHaveLength(1);
  });

  test("a user edit is appended with source 'user-edit'", () => {
    const v1 = upsertArtifactVersion(null, make({ content: "model body" }));
    const v2 = upsertArtifactVersion(
      v1,
      make({ content: "hand-tweaked body" }),
      { source: "user-edit" },
    );
    expect(v2.versions).toHaveLength(2);
    expect(v2.versions[1]!.source).toBe("user-edit");
  });

  test("artifactAtVersion returns the right content (and clamps out-of-range)", () => {
    let a = upsertArtifactVersion(null, make({ content: "alpha" }));
    a = upsertArtifactVersion(a, make({ content: "beta" }));
    expect(artifactAtVersion(a, 0).content).toBe("alpha");
    expect(artifactAtVersion(a, 1).content).toBe("beta");
    // clamp
    expect(artifactAtVersion(a, 99).content).toBe("beta");
    expect(artifactAtVersion(a, -5).content).toBe("alpha");
  });

  test("extension + mime stay correct per version", () => {
    let a = upsertArtifactVersion(
      null,
      make({ kind: "code", language: "python", content: "alpha" }),
    );
    a = upsertArtifactVersion(
      a,
      make({ kind: "code", language: "python", content: "beta" }),
    );
    expect(artifactExtension(artifactAtVersion(a, 0))).toBe("py");
    expect(artifactMime(artifactAtVersion(a, 1))).toBe("text/plain");

    let h = upsertArtifactVersion(
      null,
      { id: "h1", kind: "html", language: "html", title: "My Page", content: "<html>1</html>" },
    );
    h = upsertArtifactVersion(
      h,
      { id: "h2", kind: "html", language: "html", title: "My Page", content: "<html>2</html>" },
    );
    expect(artifactExtension(artifactAtVersion(h, 1))).toBe("html");
    expect(artifactMime(artifactAtVersion(h, 1))).toBe("text/html");
  });

  test("stable identity: re-emitting a file with a changed first comment appends v2", () => {
    const body1 = [
      "// initial version",
      "export function add(a: number, b: number): number {",
      "  return a + b;",
      "}",
    ].join("\n");
    const body2 = body1.replace("// initial version", "// revised: also handles negatives");
    // Same heuristic title, DIFFERENT first line, near-identical body.
    const v1: Artifact = { id: "m1:0", kind: "code", language: "ts", title: "add", content: body1 };
    const v2: Artifact = { id: "m2:0", kind: "code", language: "ts", title: "add", content: body2 };
    const folded = foldArtifactVersions([v1, v2]);
    expect(folded).toHaveLength(1); // one artifact, not two
    expect(folded[0]!.versions).toHaveLength(2);
    expect(folded[0]!.versions[1]!.content).toContain("handles negatives");
  });

  test("stable identity: two distinct untitled blocks with the SAME heuristic title stay apart", () => {
    const a: Artifact = {
      id: "m1:0",
      kind: "code",
      title: "Code snippet", // identical heuristic title
      content: ["function fib(n){", "  return n < 2 ? n : fib(n-1) + fib(n-2);", "}"].join("\n"),
    };
    const b: Artifact = {
      id: "m1:1",
      kind: "code",
      title: "Code snippet", // identical heuristic title
      content: ["class HttpServer {", "  listen(port){ this.port = port; }", "}"].join("\n"),
    };
    // Old title-based identity WOULD merge these; the stable scheme must not.
    expect(foldArtifactVersions([a, b])).toHaveLength(2);
  });

  test("stable identity: declared id versions across body+title changes; different ids stay separate", () => {
    const a: Artifact = { id: "m1:0", kind: "code", title: "Auth", content: "alpha body", declaredId: "auth" };
    const b: Artifact = { id: "m2:0", kind: "code", title: "Auth middleware v2", content: "completely rewritten", declaredId: "auth" };
    const c: Artifact = { id: "m3:0", kind: "code", title: "Auth", content: "alpha body", declaredId: "other" };
    const folded = foldArtifactVersions([a, b, c]);
    expect(folded).toHaveLength(2); // auth (a+b) and other (c)
    const auth = folded.find((f) => f.id === "decl:auth")!;
    expect(auth.versions).toHaveLength(2); // merged by id despite body+title change
    const other = folded.find((f) => f.id === "decl:other")!;
    expect(other.versions).toHaveLength(1); // different id ⇒ separate, even with identical body
  });

  test("foldArtifactVersions merges same identity, keeps distinct ones apart", () => {
    const flat: Artifact[] = [
      make({ id: "m1:a", content: "fib v1" }),
      { id: "m1:b", kind: "svg", language: "svg", title: "SVG image", content: "<svg>1</svg>" },
      make({ id: "m2:a", content: "fib v2" }), // re-emit of the python artifact
      { id: "m2:b", kind: "svg", language: "svg", title: "SVG image", content: "<svg>2</svg>" },
    ];
    const folded = foldArtifactVersions(flat);
    expect(folded).toHaveLength(2); // one code, one svg — not four
    const code = folded.find((f) => f.kind === "code")!;
    expect(code.versions).toHaveLength(2);
    expect(code.versions[0]!.content).toBe("fib v1");
    expect(code.versions[1]!.content).toBe("fib v2");
    // latest source id is carried for inline-reference resolution
    expect(code.versions[1]!.sourceId).toBe("m2:a");
  });
});
