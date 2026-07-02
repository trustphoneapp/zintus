import { useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { PROVIDER_IDS, type ProviderId } from "@zintus/types";
import { PROVIDER_METADATA } from "@zintus/providers";

import { saveSelectedProvider } from "@/lib/config";
import { DESTINATIONS, describeFlow } from "@/lib/data-flow";
import { fetchGatewayHealth } from "@/lib/gateway";
import { getDefaultGatewayUrl, setGatewayUrl } from "@/lib/gateway-url";
import { setApiKey } from "@/lib/keys";
import {
  setOnboardingComplete,
  setPendingPrompt,
} from "@/lib/onboarding";
import { validateProviderKey } from "@/lib/validate";
import { COLORS } from "@/lib/theme";

/**
 * Onboarding (mobile) — five steps that are a real sequence, so the progress
 * instrument is a mono step rail (01–05 + lit segments), not "Step 1 of 5"
 * prose. Checks (gateway health, key validation) read back as console status
 * lines — dot + verdict — matching the Agent screen's heartbeat language.
 */

const FREE_PROVIDERS = PROVIDER_IDS.filter(
  (id) => PROVIDER_METADATA[id]?.freeTier,
);

const SAMPLE_PROMPTS = [
  "Explain what a BYOK AI router is, in 3 bullet points.",
  "Write a TypeScript function that debounces an async call.",
  "Summarize the tradeoffs of local vs cloud LLM inference.",
];

const STEP_NAMES = ["Welcome", "Data path", "Gateway", "First key", "Launch"];
const TOTAL_STEPS = STEP_NAMES.length;

const MONO = Platform.select({ ios: "Menlo", android: "monospace" });

export default function Onboarding() {
  const router = useRouter();
  const [step, setStep] = useState(0);

  const [urlInput, setUrlInput] = useState(getDefaultGatewayUrl());
  const [checking, setChecking] = useState(false);
  const [health, setHealth] = useState<"unknown" | "online" | "offline">(
    "unknown",
  );

  const [provider, setProvider] = useState<ProviderId>(
    FREE_PROVIDERS[0] ?? "groq",
  );
  const [keyInput, setKeyInput] = useState("");
  const [testing, setTesting] = useState(false);
  const [keyResult, setKeyResult] = useState<"none" | "ok" | "bad">("none");

  function finish(prompt?: string) {
    if (prompt) setPendingPrompt(prompt);
    setOnboardingComplete();
    router.replace("/");
  }

  async function checkHealth() {
    setChecking(true);
    setGatewayUrl(urlInput);
    const result = await fetchGatewayHealth();
    setHealth(result?.ok ? "online" : "offline");
    setChecking(false);
  }

  async function testKey() {
    if (!keyInput.trim()) return;
    setTesting(true);
    setKeyResult("none");
    const valid = await validateProviderKey(provider, keyInput.trim());
    if (valid) {
      await setApiKey(provider, keyInput.trim());
      saveSelectedProvider(provider);
      setKeyResult("ok");
    } else {
      setKeyResult("bad");
    }
    setTesting(false);
  }

  const meta = PROVIDER_METADATA[provider];

  return (
    <View style={styles.container}>
      {/* Step rail — the progress instrument. */}
      <View style={styles.railHead}>
        <Text style={styles.railIndex}>
          {String(step + 1).padStart(2, "0")} / {String(TOTAL_STEPS).padStart(2, "0")}
        </Text>
        <Text style={styles.railName}>{STEP_NAMES[step]}</Text>
        <View style={{ flex: 1 }} />
        <Pressable hitSlop={8} onPress={() => finish()}>
          <Text style={styles.skip}>Skip</Text>
        </Pressable>
      </View>
      <View style={styles.rail}>
        {STEP_NAMES.map((name, i) => (
          <View
            key={name}
            style={[
              styles.railSeg,
              i < step && styles.railSegDone,
              i === step && styles.railSegActive,
            ]}
          />
        ))}
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {step === 0 && (
          <View>
            <Text style={styles.h1}>Welcome to Zintus</Text>
            <Text style={styles.lead}>
              A bring-your-own-key AI router. Zintus does not sell model access —
              you connect your own provider keys (or local models) and it routes
              every request through your own gateway, with privacy you can see.
            </Text>
            <View style={styles.bullets}>
              <Text style={styles.bullet}>• Your keys stay on this device.</Text>
              <Text style={styles.bullet}>
                • Tokzen compresses each turn to stretch free tiers.
              </Text>
              <Text style={styles.bullet}>
                • Every answer shows provider, savings, and quota.
              </Text>
            </View>
          </View>
        )}

        {step === 1 && (
          <View>
            <Text style={styles.h1}>Where your data goes</Text>
            <Text style={styles.lead}>
              Zintus is local-first. Here is exactly what travels where:
            </Text>
            {describeFlow("standard").map((item, i) => (
              <View key={i} style={styles.flowItem}>
                <Text style={styles.flowDest}>
                  {DESTINATIONS[item.destination].label.toUpperCase()}
                </Text>
                <Text style={styles.flowData}>{item.data}</Text>
                <Text style={styles.flowDetail}>{item.detail}</Text>
              </View>
            ))}
            <Text style={styles.note}>
              You need your own provider key or a local runtime, and the gateway
              must be running to route. The relay never processes your prompts.
            </Text>
          </View>
        )}

        {step === 2 && (
          <View>
            <Text style={styles.h1}>Connect your gateway</Text>
            <Text style={styles.lead}>
              Run `zintus serve` on your computer, then point the app at it (use
              your computer&apos;s LAN IP, not localhost, from a physical phone).
            </Text>
            <TextInput
              style={[styles.input, styles.inputMono]}
              value={urlInput}
              onChangeText={setUrlInput}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="http://192.168.1.20:8787"
              placeholderTextColor={COLORS.muted}
            />
            <Pressable
              style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
              onPress={() => void checkHealth()}
            >
              {checking ? (
                <ActivityIndicator color={COLORS.accentBright} />
              ) : (
                <Text style={styles.secondaryBtnText}>Check health</Text>
              )}
            </Pressable>
            {health !== "unknown" && (
              <StatusLine
                ok={health === "online"}
                text={
                  health === "online"
                    ? "Gateway reachable"
                    : "Gateway not reachable — you can still continue and set it later."
                }
              />
            )}
          </View>
        )}

        {step === 3 && (
          <View>
            <Text style={styles.h1}>Add your first provider key</Text>
            <Text style={styles.lead}>
              Pick a provider with a free tier, paste your key, and test it. The
              key is stored only in this device&apos;s secure store.
            </Text>
            <View style={styles.providerRow}>
              {FREE_PROVIDERS.map((id) => (
                <Pressable
                  key={id}
                  onPress={() => {
                    setProvider(id);
                    setKeyResult("none");
                  }}
                  style={({ pressed }) => [
                    styles.providerChip,
                    provider === id && styles.providerChipActive,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text
                    style={[
                      styles.providerChipText,
                      provider === id && styles.providerChipTextActive,
                    ]}
                  >
                    {PROVIDER_METADATA[id]?.name ?? id}
                  </Text>
                </Pressable>
              ))}
            </View>
            {meta?.keyUrl ? (
              <Pressable onPress={() => void Linking.openURL(meta.keyUrl!)}>
                <Text style={styles.link}>Get a {meta.name} key →</Text>
              </Pressable>
            ) : null}
            <TextInput
              style={[styles.input, styles.inputMono]}
              value={keyInput}
              onChangeText={(t) => {
                setKeyInput(t);
                setKeyResult("none");
              }}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              placeholder={meta?.keyPrefix ? `${meta.keyPrefix}…` : "Paste key"}
              placeholderTextColor={COLORS.muted}
            />
            <Pressable
              style={({ pressed }) => [styles.secondaryBtn, pressed && styles.pressed]}
              onPress={() => void testKey()}
            >
              {testing ? (
                <ActivityIndicator color={COLORS.accentBright} />
              ) : (
                <Text style={styles.secondaryBtnText}>Test &amp; save key</Text>
              )}
            </Pressable>
            {keyResult === "ok" && <StatusLine ok text="Key valid and saved" />}
            {keyResult === "bad" && (
              <StatusLine
                ok={false}
                text="Key didn't validate — check it, or continue and add one later."
              />
            )}
          </View>
        )}

        {step === 4 && (
          <View>
            <Text style={styles.h1}>You&apos;re set</Text>
            <Text style={styles.lead}>
              Auto Routing is on by default — Zintus picks the best available free
              provider for each message. Try a sample prompt:
            </Text>
            {SAMPLE_PROMPTS.map((prompt) => (
              <Pressable
                key={prompt}
                onPress={() => finish(prompt)}
                style={({ pressed }) => [styles.sampleBtn, pressed && styles.pressed]}
              >
                <Text style={styles.sampleText}>{prompt}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>

      <View style={styles.nav}>
        {step > 0 ? (
          <Pressable
            style={({ pressed }) => [styles.navBtn, pressed && styles.pressed]}
            onPress={() => setStep((s) => Math.max(0, s - 1))}
          >
            <Text style={styles.navBtnText}>Back</Text>
          </Pressable>
        ) : (
          <View />
        )}
        {step < TOTAL_STEPS - 1 ? (
          <Pressable
            style={({ pressed }) => [styles.navBtnPrimary, pressed && styles.pressed]}
            onPress={() => setStep((s) => s + 1)}
          >
            <Text style={styles.navBtnPrimaryText}>Continue</Text>
          </Pressable>
        ) : (
          <Pressable
            style={({ pressed }) => [styles.navBtnPrimary, pressed && styles.pressed]}
            onPress={() => finish()}
          >
            <Text style={styles.navBtnPrimaryText}>Start chatting</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

/** Console-style verdict: dot + plain sentence, green for pass, red for fail. */
function StatusLine({ ok, text }: { ok: boolean; text: string }) {
  const color = ok ? COLORS.good : COLORS.error;
  return (
    <View style={styles.statusLine}>
      <View style={[styles.statusDot, { backgroundColor: color }]} />
      <Text style={[styles.statusText, { color }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.surface, paddingTop: 56 },
  railHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 20,
    paddingBottom: 10,
  },
  railIndex: { color: COLORS.accentBright, fontFamily: MONO, fontSize: 12 },
  railName: {
    color: COLORS.muted,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  skip: { color: COLORS.accentBright, fontSize: 14, fontWeight: "700" },
  rail: {
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 20,
    paddingBottom: 14,
  },
  railSeg: {
    flex: 1,
    height: 3,
    borderRadius: 2,
    backgroundColor: COLORS.border,
  },
  railSegDone: { backgroundColor: COLORS.muted },
  railSegActive: { backgroundColor: COLORS.accentBright },

  body: { paddingHorizontal: 20, paddingBottom: 24 },
  h1: { color: COLORS.ink, fontSize: 26, fontWeight: "800", marginBottom: 12 },
  lead: { color: COLORS.muted, fontSize: 15, lineHeight: 22, marginBottom: 16 },
  bullets: { gap: 8 },
  bullet: { color: COLORS.ink, fontSize: 15, lineHeight: 22 },
  note: {
    color: COLORS.muted,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 14,
    fontStyle: "italic",
  },
  flowItem: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
    paddingVertical: 10,
  },
  flowDest: {
    color: COLORS.accentBright,
    fontSize: 11,
    fontFamily: MONO,
    letterSpacing: 0.5,
  },
  flowData: { color: COLORS.ink, fontSize: 14, fontWeight: "600", marginTop: 2 },
  flowDetail: { color: COLORS.muted, fontSize: 13, lineHeight: 18, marginTop: 2 },
  input: {
    backgroundColor: COLORS.panel,
    color: COLORS.ink,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginBottom: 12,
  },
  inputMono: { fontFamily: MONO, fontSize: 13 },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: COLORS.accent,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  secondaryBtnText: { color: COLORS.accentBright, fontWeight: "700", fontSize: 15 },
  statusLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 12,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { flex: 1, fontSize: 13, lineHeight: 18, fontWeight: "600" },
  providerRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  providerChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: COLORS.panel,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  providerChipActive: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  providerChipText: { color: COLORS.accentBright, fontWeight: "600" },
  providerChipTextActive: { color: COLORS.onAccent, fontWeight: "800" },
  link: { color: COLORS.accentBright, fontSize: 14, marginBottom: 12, fontWeight: "600" },
  sampleBtn: {
    backgroundColor: COLORS.panel,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  sampleText: { color: COLORS.ink, fontSize: 15, lineHeight: 21 },
  nav: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  navBtn: { paddingHorizontal: 18, paddingVertical: 11 },
  navBtnText: { color: COLORS.muted, fontWeight: "700", fontSize: 15 },
  navBtnPrimary: {
    backgroundColor: COLORS.accent,
    borderRadius: 10,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  navBtnPrimaryText: { color: COLORS.onAccent, fontWeight: "800", fontSize: 15 },
  pressed: { opacity: 0.7 },
});
