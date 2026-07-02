/**
 * Voice dictation via on-device speech recognition — a GUARDED integration.
 *
 * `expo-speech-recognition` is a native module that only works in a dev/preview
 * build (not Expo Go) and cannot be verified in CI or on a simulator here, so it
 * is NOT a hard dependency. This module dynamically loads it if present and
 * exposes a tiny start/stop API; when it is absent, `isSpeechAvailable()`
 * returns false and the composer keeps its honest "dictation unavailable"
 * fallback. Same posture as the agent's browser tool (graceful absence).
 *
 * ENABLE (dev step, documented in STORE-SUBMISSION.md): `npx expo install
 * expo-speech-recognition`, unblock RECORD_AUDIO + add the mic/speech purpose
 * strings, and rebuild — the composer mic then dictates into the input. Zintus
 * NEVER auto-sends a transcript; it only fills the text field.
 */

// Loosely-typed handle to the optional module (avoids a hard type dependency).
interface SpeechModule {
  ExpoSpeechRecognitionModule: {
    requestPermissionsAsync(): Promise<{ granted: boolean }>;
    start(options: Record<string, unknown>): void;
    stop(): void;
  };
  addSpeechRecognitionListener(
    event: string,
    handler: (payload: { results?: Array<{ transcript?: string }>; error?: string }) => void,
  ): { remove(): void };
}

let cached: SpeechModule | null | undefined;

async function loadSpeech(): Promise<SpeechModule | null> {
  if (cached !== undefined) return cached;
  try {
    // Indirect specifier so bundlers/TS don't hard-resolve the optional module.
    const spec = "expo-speech-recognition";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cached = (await import(spec)) as unknown as SpeechModule;
  } catch {
    cached = null;
  }
  return cached;
}

/** True when the native speech module is installed in this build. */
export async function isSpeechAvailable(): Promise<boolean> {
  return (await loadSpeech()) !== null;
}

export interface SpeechSession {
  stop(): void;
}

export interface StartDictationCallbacks {
  /** Fired with the best transcript so far (partial + final). Never auto-sends. */
  onTranscript(text: string): void;
  onError(message: string): void;
  onEnd(): void;
}

/**
 * Start dictation. Returns a session handle (call `stop()`), or a reason string
 * when speech is unavailable / permission denied. The caller fills the composer
 * from `onTranscript` — sending stays an explicit user action.
 */
export async function startDictation(
  cb: StartDictationCallbacks,
): Promise<SpeechSession | { unavailable: string }> {
  const mod = await loadSpeech();
  if (!mod) {
    return {
      unavailable:
        "On-device dictation isn't enabled in this build. Add expo-speech-recognition to a dev/preview build to turn it on. For now, type your message — Zintus never auto-sends a voice transcript.",
    };
  }
  const perm = await mod.ExpoSpeechRecognitionModule.requestPermissionsAsync();
  if (!perm.granted) {
    return {
      unavailable:
        "Microphone/speech permission was denied. Enable it in your device Settings to dictate.",
    };
  }
  const resultSub = mod.addSpeechRecognitionListener("result", (payload) => {
    const transcript = payload.results?.[0]?.transcript;
    if (typeof transcript === "string") cb.onTranscript(transcript);
  });
  const errorSub = mod.addSpeechRecognitionListener("error", (payload) => {
    cb.onError(payload.error ?? "Dictation failed.");
  });
  const endSub = mod.addSpeechRecognitionListener("end", () => cb.onEnd());

  mod.ExpoSpeechRecognitionModule.start({
    lang: "en-US",
    interimResults: true,
    continuous: false,
  });

  return {
    stop() {
      try {
        mod.ExpoSpeechRecognitionModule.stop();
      } finally {
        resultSub.remove();
        errorSub.remove();
        endSub.remove();
      }
    },
  };
}
