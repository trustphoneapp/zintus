"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Voice input (dictation) via the browser-native Web Speech API.
 *
 * HONEST scope:
 * - This is the BROWSER's speech recognizer — `window.SpeechRecognition` or the
 *   `webkitSpeechRecognition` prefix. Chrome/Edge stream audio to a Google
 *   speech service; other engines vary. NO audio touches Zintus, the gateway, or
 *   the relay — dictation only fills the composer textarea. The user still hits
 *   send, so the recognized text rides the normal chat path like anything typed.
 * - Support is uneven: Chromium has it; Firefox/Safari are partial or absent.
 *   We feature-detect and tell the truth rather than pretend it works everywhere.
 *
 * No backend, no new dependency, no eval — CSP-safe.
 */

// ── Minimal structural types ────────────────────────────────────────────────
// The Web Speech API isn't in every TS lib target, and it's vendor-prefixed, so
// we model only the surface we touch instead of pulling a DOM-lib dependency.
export interface SpeechAlternativeLike {
  readonly transcript: string;
}
export interface SpeechResultLike {
  readonly 0: SpeechAlternativeLike;
  readonly isFinal: boolean;
  readonly length: number;
}
export interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechResultLike>;
}
export interface SpeechRecognitionErrorEventLike {
  readonly error: string;
}
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
export interface SpeechRecognitionCtor {
  new (): SpeechRecognitionLike;
}

interface SpeechWindow {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
  navigator?: { language?: string };
}

/**
 * Feature-detect the recognizer constructor. Prefers the standard name, falls
 * back to the WebKit prefix, returns null when neither exists (or off-DOM, e.g.
 * SSR). Accepts an injected window so the logic is testable without a browser.
 */
export function getSpeechRecognitionCtor(
  win: SpeechWindow | undefined = typeof window !== "undefined"
    ? (window as unknown as SpeechWindow)
    : undefined,
): SpeechRecognitionCtor | null {
  if (!win) return null;
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

/**
 * Split a recognition event into the just-finalized text and the still-interim
 * text, scanning only from `resultIndex` (the spec marks where new results
 * begin, so we never double-count earlier finalized segments). Pure + the core
 * of transcript accumulation.
 */
export function collectTranscript(event: SpeechRecognitionEventLike): {
  final: string;
  interim: string;
} {
  let final = "";
  let interim = "";
  const results = event.results;
  for (let i = event.resultIndex; i < results.length; i += 1) {
    const result = results[i];
    if (!result) continue;
    const text = result[0]?.transcript ?? "";
    if (result.isFinal) final += text;
    else interim += text;
  }
  return { final, interim };
}

/**
 * Append a finalized dictation chunk to existing composer text, inserting a
 * single separating space only when both sides are non-empty and not already
 * whitespace-bounded. Keeps "hello" + "world" → "hello world", never "helloworld"
 * or stray leading spaces.
 */
export function appendDictation(base: string, chunk: string): string {
  const addition = chunk.trim();
  if (!addition) return base;
  if (!base) return addition;
  const needsSpace = !/\s$/.test(base);
  return base + (needsSpace ? " " : "") + addition;
}

/** A calm, human reason for a recognition error — never the raw error code. */
export function describeSpeechError(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access is blocked — allow it in your browser to dictate.";
    case "no-speech":
      return "Didn't catch that — try speaking again.";
    case "audio-capture":
      return "No microphone found — check that one is connected.";
    case "network":
      return "The browser's speech service is unreachable right now.";
    case "aborted":
      return ""; // user/programmatic stop — not worth a notice
    default:
      return "Voice input stopped unexpectedly — try again.";
  }
}

export interface UseSpeechRecognition {
  /** True only when the browser exposes a usable recognizer. */
  supported: boolean;
  /** True while actively listening. */
  listening: boolean;
  /** Live, not-yet-finalized words (for an inline preview); cleared on stop. */
  transcript: string;
  /** Calm, already-humanized error message, or null. */
  error: string | null;
  start(): void;
  stop(): void;
}

export interface UseSpeechRecognitionOptions {
  /**
   * Called with each finalized chunk so the caller can append it to its own
   * input state (the composer textarea stays the single source of truth).
   */
  onFinalTranscript: (chunk: string) => void;
  /** BCP-47 locale; defaults to the browser's language. */
  lang?: string;
}

/**
 * React hook wrapping the recognizer. Owns the listening lifecycle, surfaces
 * interim text for a preview, hands finalized chunks to `onFinalTranscript`, and
 * tears the instance down on stop/unmount so no recognizer lingers.
 */
export function useSpeechRecognition(
  options: UseSpeechRecognitionOptions,
): UseSpeechRecognition {
  const { onFinalTranscript, lang } = options;
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // Keep the callback fresh without re-binding handlers each render.
  const onFinalRef = useRef(onFinalTranscript);
  useEffect(() => {
    onFinalRef.current = onFinalTranscript;
  }, [onFinalTranscript]);

  useEffect(() => {
    setSupported(getSpeechRecognitionCtor() !== null);
  }, []);

  const teardown = useCallback(() => {
    const recognition = recognitionRef.current;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.onstart = null;
      try {
        recognition.abort();
      } catch {
        // already stopped — nothing to clean up
      }
      recognitionRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    const recognition = recognitionRef.current;
    if (recognition) {
      try {
        recognition.stop();
      } catch {
        // ignore — onend still fires the teardown
      }
    }
    setListening(false);
    setTranscript("");
  }, []);

  const start = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setSupported(false);
      return;
    }
    // Already listening — ignore a double toggle rather than stacking instances.
    if (recognitionRef.current) return;

    setError(null);
    setTranscript("");

    let recognition: SpeechRecognitionLike;
    try {
      recognition = new Ctor();
    } catch {
      setError("Voice input couldn't start in this browser.");
      return;
    }
    recognition.lang =
      lang ||
      (typeof navigator !== "undefined" ? navigator.language : "") ||
      "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onstart = () => setListening(true);
    recognition.onresult = (event) => {
      const { final, interim } = collectTranscript(event);
      if (final) onFinalRef.current(final);
      setTranscript(interim);
    };
    recognition.onerror = (event) => {
      const message = describeSpeechError(event.error);
      if (message) setError(message);
    };
    recognition.onend = () => {
      setListening(false);
      setTranscript("");
      teardown();
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      setError("Voice input couldn't start — try again.");
      teardown();
    }
  }, [lang, teardown]);

  // Clean up any live recognizer when the component unmounts.
  useEffect(() => teardown, [teardown]);

  return { supported, listening, transcript, error, start, stop };
}
