import type { RunEvent } from "./engineer";

export interface ParsedEngineerSse {
  events: Array<{ id: number; event: RunEvent }>;
  remainder: string;
  retryMs: number | null;
}

/** Parses complete SSE frames while preserving partial data for the next network chunk. */
export function parseEngineerSse(input: string): ParsedEngineerSse {
  const normalized = input.replaceAll("\r\n", "\n");
  const frames = normalized.split("\n\n");
  const remainder = frames.pop() ?? "";
  const events: ParsedEngineerSse["events"] = [];
  let retryMs: number | null = null;
  for (const frame of frames) {
    if (!frame || frame.startsWith(":")) continue;
    const lines = frame.split("\n");
    const retry = lines.find((line) => line.startsWith("retry:"));
    if (retry) {
      const value = Number(retry.slice(6).trim());
      if (Number.isSafeInteger(value) && value >= 100 && value <= 60_000) retryMs = value;
    }
    const idLine = lines.find((line) => line.startsWith("id:"));
    const dataLines = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart());
    if (!idLine || dataLines.length === 0) continue;
    const id = Number(idLine.slice(3).trim());
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("Engineer stream supplied an invalid event ID");
    const event = JSON.parse(dataLines.join("\n")) as RunEvent;
    if (event.sequence !== id || typeof event.eventId !== "string") throw new Error("Engineer stream event sequence mismatch");
    events.push({ id, event });
  }
  return { events, remainder, retryMs };
}

export function acceptEngineerEvent(lastSequence: number, nextSequence: number): "ACCEPT" | "DUPLICATE" | "GAP" {
  if (nextSequence <= lastSequence) return "DUPLICATE";
  if (nextSequence !== lastSequence + 1) return "GAP";
  return "ACCEPT";
}
