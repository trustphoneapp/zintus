"use client";

import { useMemo, useState } from "react";
import { Icon } from "./Icons";

/**
 * Dependency-free Markdown renderer for web chat answers — a verbatim port of
 * the desktop/mobile renderer so all three surfaces render the same constructs
 * (headings, lists, tables, inline + fenced code with copy, blockquotes, links).
 * Kept dep-free on purpose (no react-markdown/shiki in the web bundle). Not a full
 * CommonMark parser — it targets what LLM answers actually emit and degrades to
 * readable text otherwise. Replaces the old line-formatter that silently stripped
 * ``` fences (FEATURE-MATRIX #7/#8 honesty fix).
 */

type Block =
  | { kind: "code"; lang: string; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "hr" }
  | { kind: "quote"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "p"; text: string };

const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^(\s*([-*_])\s*(?:\2\s*){2,})$/;
const UL = /^\s*[-*+]\s+(.*)$/;
const OL = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/;

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const at = (k: number): string => lines[k] ?? "";
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = at(i);
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      const lang = (fence[1] ?? "").trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(at(i))) body.push(at(i++));
      i++;
      blocks.push({ kind: "code", lang, text: body.join("\n") });
      continue;
    }
    if (line.trim() === "") { i++; continue; }
    if (HR.test(line)) { blocks.push({ kind: "hr" }); i++; continue; }
    const heading = line.match(HEADING);
    if (heading) { blocks.push({ kind: "heading", level: (heading[1] ?? "").length, text: heading[2] ?? "" }); i++; continue; }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(at(i + 1))) {
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && at(i).includes("|") && at(i).trim() !== "") rows.push(splitRow(at(i++)));
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    if (QUOTE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && QUOTE.test(at(i))) buf.push(at(i++).match(QUOTE)?.[1] ?? "");
      blocks.push({ kind: "quote", text: buf.join("\n") });
      continue;
    }
    if (UL.test(line)) {
      const items: string[] = [];
      while (i < lines.length && UL.test(at(i))) items.push(at(i++).match(UL)?.[1] ?? "");
      blocks.push({ kind: "ul", items });
      continue;
    }
    if (OL.test(line)) {
      const items: string[] = [];
      while (i < lines.length && OL.test(at(i))) items.push(at(i++).match(OL)?.[1] ?? "");
      blocks.push({ kind: "ol", items });
      continue;
    }
    const buf: string[] = [];
    while (
      i < lines.length && at(i).trim() !== "" &&
      !HEADING.test(at(i)) && !HR.test(at(i)) && !UL.test(at(i)) &&
      !OL.test(at(i)) && !QUOTE.test(at(i)) && !/^\s*```/.test(at(i))
    ) buf.push(at(i++));
    blocks.push({ kind: "p", text: buf.join(" ") });
  }
  return blocks;
}

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^)]+\))/g;

function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  INLINE.lastIndex = 0;
  let n = 0;
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const tok = match[0] ?? "";
    const key = `${keyBase}-${n++}`;
    if (tok.startsWith("`")) out.push(<code key={key} className="md-inline-code">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("**") || tok.startsWith("__")) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("[")) {
      const m = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      out.push(<a key={key} href={m?.[2] ?? "#"} target="_blank" rel="noreferrer">{m?.[1] ?? tok}</a>);
    } else out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    last = match.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Fenced code / preformatted block with a header (language label + copy button).
 * Exported so non-markdown surfaces (e.g. structured-output / JSON cards in
 * MessageBubble) can reuse the exact same chrome. `label` overrides the header
 * caption when you want something more descriptive than the bare language.
 */
export function CodeBlock({
  lang,
  text,
  label,
}: {
  lang: string;
  text: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <div className="md-code-block">
      <div className="md-code-head">
        <span className="md-code-lang">{label ?? (lang || "code")}</span>
        <button
          type="button"
          className={`md-code-copy${copied ? " is-copied" : ""}`}
          onClick={() => void copy()}
          aria-label={copied ? "Copied" : "Copy code"}
        >
          <Icon name={copied ? "check" : "copy"} size={12} />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="md-code-pre"><code>{text}</code></pre>
    </div>
  );
}

export function Markdown({ content }: { content: string }) {
  const blocks = useMemo(() => parseBlocks(content), [content]);
  return (
    <div className="md">
      {blocks.map((block, idx) => {
        const key = `b${idx}`;
        switch (block.kind) {
          case "code":
            return <CodeBlock key={key} lang={block.lang} text={block.text} />;
          case "heading": {
            const Tag = (`h${Math.min(block.level, 6)}`) as keyof React.JSX.IntrinsicElements;
            return <Tag key={key} className="md-heading">{renderInline(block.text, key)}</Tag>;
          }
          case "hr":
            return <hr key={key} className="md-hr" />;
          case "quote":
            return <blockquote key={key} className="md-quote">{renderInline(block.text, key)}</blockquote>;
          case "ul":
            return <ul key={key} className="md-ul">{block.items.map((it, j) => <li key={j}>{renderInline(it, `${key}-${j}`)}</li>)}</ul>;
          case "ol":
            return <ol key={key} className="md-ol">{block.items.map((it, j) => <li key={j}>{renderInline(it, `${key}-${j}`)}</li>)}</ol>;
          case "table":
            return (
              <table key={key} className="md-table">
                <thead><tr>{block.header.map((c, ci) => <th key={ci}>{renderInline(c, `${key}-h${ci}`)}</th>)}</tr></thead>
                <tbody>{block.rows.map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci}>{renderInline(c, `${key}-r${ri}c${ci}`)}</td>)}</tr>)}</tbody>
              </table>
            );
          case "p":
          default:
            return <p key={key} className="md-p">{renderInline(block.text, key)}</p>;
        }
      })}
    </div>
  );
}
