import { Fragment, memo, type ReactNode } from "react";
import {
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { COLORS } from "@/lib/theme";

/**
 * A dependency-free Markdown renderer for chat answers and research reports.
 *
 * We deliberately hand-roll a pragmatic subset (headings, bold/italic, inline
 * code, fenced code blocks with copy, ordered/unordered lists, blockquotes,
 * pipe tables, horizontal rules, links) instead of pulling in markdown-it +
 * a native renderer. That keeps the EAS build lean and sidesteps the
 * duplicate-native-dependency risk the project is wary of. It is NOT a
 * spec-complete CommonMark parser — it targets the constructs LLM answers
 * actually emit, and degrades to readable plain text for anything else.
 */

const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

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
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      const lang = fence[1].trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // consume closing fence
      blocks.push({ kind: "code", lang, text: body.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        text: heading[2],
      });
      i++;
      continue;
    }

    // Table: header row followed by a |---|---| separator
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    if (QUOTE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        buf.push(lines[i].match(QUOTE)![1]);
        i++;
      }
      blocks.push({ kind: "quote", text: buf.join("\n") });
      continue;
    }

    if (UL.test(line)) {
      const items: string[] = [];
      while (i < lines.length && UL.test(lines[i])) {
        items.push(lines[i].match(UL)![1]);
        i++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    if (OL.test(line)) {
      const items: string[] = [];
      while (i < lines.length && OL.test(lines[i])) {
        items.push(lines[i].match(OL)![1]);
        i++;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }

    // Paragraph: gather consecutive plain lines
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !HEADING.test(lines[i]) &&
      !HR.test(lines[i]) &&
      !UL.test(lines[i]) &&
      !OL.test(lines[i]) &&
      !QUOTE.test(lines[i]) &&
      !/^\s*```/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ kind: "p", text: buf.join(" ") });
  }

  return blocks;
}

// Inline: `code`, **bold**, *italic*, [text](url). Tokenized in one pass so
// styles don't bleed across markers.
const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^)]+\))/g;

function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  INLINE.lastIndex = 0;
  let n = 0;
  while ((match = INLINE.exec(text)) !== null) {
    if (match.index > last) {
      out.push(<Fragment key={`${keyBase}-t${n}`}>{text.slice(last, match.index)}</Fragment>);
    }
    const tok = match[0];
    const key = `${keyBase}-m${n}`;
    if (tok.startsWith("`")) {
      out.push(
        <Text key={key} style={styles.inlineCode}>
          {tok.slice(1, -1)}
        </Text>,
      );
    } else if (tok.startsWith("**") || tok.startsWith("__")) {
      out.push(
        <Text key={key} style={styles.bold}>
          {tok.slice(2, -2)}
        </Text>,
      );
    } else if (tok.startsWith("[")) {
      const m = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/)!;
      out.push(
        <Text key={key} style={styles.link} onPress={() => void Linking.openURL(m[2])}>
          {m[1]}
        </Text>,
      );
    } else {
      out.push(
        <Text key={key} style={styles.italic}>
          {tok.slice(1, -1)}
        </Text>,
      );
    }
    last = match.index + tok.length;
    n++;
  }
  if (last < text.length) {
    out.push(<Fragment key={`${keyBase}-tend`}>{text.slice(last)}</Fragment>);
  }
  return out;
}

interface MarkdownProps {
  content: string;
  /** Receives the raw text of a fenced code block when its Copy button is hit. */
  onCopyCode?: (code: string) => void;
}

const HEADING_SIZE = [22, 20, 18, 16, 15, 14];

function MarkdownImpl({ content, onCopyCode }: MarkdownProps) {
  const blocks = parseBlocks(content);
  return (
    <View>
      {blocks.map((block, idx) => {
        const key = `b${idx}`;
        switch (block.kind) {
          case "code":
            return (
              <View key={key} style={styles.codeBlock}>
                <View style={styles.codeHeader}>
                  <Text style={styles.codeLang}>{block.lang || "code"}</Text>
                  {onCopyCode ? (
                    <Pressable
                      hitSlop={8}
                      onPress={() => onCopyCode(block.text)}
                      style={({ pressed }) => pressed && styles.pressed}
                    >
                      <Text style={styles.codeCopy}>Copy</Text>
                    </Pressable>
                  ) : null}
                </View>
                <Text style={styles.codeText} selectable>
                  {block.text}
                </Text>
              </View>
            );
          case "heading":
            return (
              <Text
                key={key}
                style={[
                  styles.heading,
                  { fontSize: HEADING_SIZE[block.level - 1] ?? 14 },
                ]}
              >
                {renderInline(block.text, key)}
              </Text>
            );
          case "hr":
            return <View key={key} style={styles.hr} />;
          case "quote":
            return (
              <View key={key} style={styles.quote}>
                <Text style={styles.quoteText}>{renderInline(block.text, key)}</Text>
              </View>
            );
          case "ul":
            return (
              <View key={key} style={styles.list}>
                {block.items.map((item, j) => (
                  <View key={`${key}-${j}`} style={styles.listItem}>
                    <Text style={styles.bullet}>•</Text>
                    <Text style={styles.listText}>{renderInline(item, `${key}-${j}`)}</Text>
                  </View>
                ))}
              </View>
            );
          case "ol":
            return (
              <View key={key} style={styles.list}>
                {block.items.map((item, j) => (
                  <View key={`${key}-${j}`} style={styles.listItem}>
                    <Text style={styles.bullet}>{j + 1}.</Text>
                    <Text style={styles.listText}>{renderInline(item, `${key}-${j}`)}</Text>
                  </View>
                ))}
              </View>
            );
          case "table":
            return (
              <View key={key} style={styles.table}>
                <View style={[styles.tableRow, styles.tableHeaderRow]}>
                  {block.header.map((cell, c) => (
                    <Text key={`${key}-h${c}`} style={[styles.tableCell, styles.tableHeaderCell]}>
                      {renderInline(cell, `${key}-h${c}`)}
                    </Text>
                  ))}
                </View>
                {block.rows.map((row, r) => (
                  <View key={`${key}-r${r}`} style={styles.tableRow}>
                    {row.map((cell, c) => (
                      <Text key={`${key}-r${r}c${c}`} style={styles.tableCell}>
                        {renderInline(cell, `${key}-r${r}c${c}`)}
                      </Text>
                    ))}
                  </View>
                ))}
              </View>
            );
          case "p":
          default:
            return (
              <Text key={key} style={styles.paragraph} selectable>
                {renderInline(block.text, key)}
              </Text>
            );
        }
      })}
    </View>
  );
}

export const Markdown = memo(MarkdownImpl);

const styles = StyleSheet.create({
  paragraph: { color: COLORS.ink, fontSize: 15, lineHeight: 22, marginBottom: 4 },
  heading: { color: COLORS.ink, fontWeight: "800", marginTop: 8, marginBottom: 4 },
  bold: { fontWeight: "800", color: COLORS.ink },
  italic: { fontStyle: "italic" },
  link: { color: COLORS.accentBright, textDecorationLine: "underline" },
  inlineCode: {
    fontFamily: MONO,
    fontSize: 13,
    color: COLORS.good,
    backgroundColor: "rgba(148,163,184,0.12)",
  },
  codeBlock: {
    backgroundColor: "#0a0e13",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginVertical: 6,
    overflow: "hidden",
  },
  codeHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
    backgroundColor: COLORS.panel,
  },
  codeLang: { color: COLORS.muted, fontSize: 11, textTransform: "lowercase" },
  codeCopy: { color: COLORS.accentBright, fontSize: 12, fontWeight: "700" },
  codeText: { fontFamily: MONO, fontSize: 13, color: COLORS.ink, padding: 10, lineHeight: 19 },
  hr: { height: 1, backgroundColor: COLORS.border, marginVertical: 10 },
  quote: {
    borderLeftWidth: 3,
    borderLeftColor: COLORS.accent,
    paddingLeft: 10,
    marginVertical: 4,
  },
  quoteText: { color: COLORS.muted, fontStyle: "italic", fontSize: 15, lineHeight: 22 },
  list: { marginVertical: 4, gap: 2 },
  listItem: { flexDirection: "row", gap: 8, paddingRight: 8 },
  bullet: { color: COLORS.muted, fontSize: 15, lineHeight: 22, minWidth: 18 },
  listText: { color: COLORS.ink, fontSize: 15, lineHeight: 22, flex: 1 },
  table: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    marginVertical: 6,
    overflow: "hidden",
  },
  tableRow: { flexDirection: "row" },
  tableHeaderRow: { backgroundColor: COLORS.panel },
  tableCell: {
    flex: 1,
    color: COLORS.ink,
    fontSize: 13,
    padding: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.border,
  },
  tableHeaderCell: { fontWeight: "800" },
  pressed: { opacity: 0.6 },
});
