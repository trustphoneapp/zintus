import { describe, expect, test } from "bun:test";
import {
  extractArtifacts,
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
    expect(v2.id).toBe(v1.id);
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

  test("foldArtifactVersions merges same identity, keeps distinct ones apart", () => {
    const flat: Artifact[] = [
      make({ id: "m1:a", content: "fib v1" }),
      { id: "m1:b", kind: "svg", language: "svg", title: "SVG image", content: "<svg>1</svg>" },
      make({ id: "m2:a", content: "fib v2" }),
      { id: "m2:b", kind: "svg", language: "svg", title: "SVG image", content: "<svg>2</svg>" },
    ];
    const folded = foldArtifactVersions(flat);
    expect(folded).toHaveLength(2);
    const code = folded.find((f) => f.kind === "code")!;
    expect(code.versions).toHaveLength(2);
    expect(code.versions[0]!.content).toBe("fib v1");
    expect(code.versions[1]!.content).toBe("fib v2");
    expect(code.versions[1]!.sourceId).toBe("m2:a");
  });
});
