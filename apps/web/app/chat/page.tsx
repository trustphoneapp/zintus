"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Page from "../_components/Page";
import { ProviderRail } from "../_components/ProviderRail";
import type { ProviderId } from "@multipleai/types";
import {
  useProviderStatusStore,
  useSettingsStore,
} from "@/lib/store";

const PASSPHRASE_KEY = "multipleai.web.passphrase.session";

export default function ChatPage() {
  const { settings, hydrate } = useSettingsStore();
  const { passphrase, keys, setPassphrase, unlock } = useProviderStatusStore();
  const [prompt, setPrompt] = useState("");
  const [output, setOutput] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<ProviderId | null>(null);
  const [activeProvider, setActiveProvider] = useState<ProviderId | null>(null);
  const [meta, setMeta] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    hydrate();
    const saved = sessionStorage.getItem(PASSPHRASE_KEY);
    if (saved) {
      setPassphrase(saved);
    }
  }, [hydrate, setPassphrase]);

  useEffect(() => {
    if (passphrase) {
      sessionStorage.setItem(PASSPHRASE_KEY, passphrase);
    }
    void unlock();
  }, [passphrase, unlock]);

  useEffect(() => {
    outputRef.current?.scrollTo(0, outputRef.current.scrollHeight);
  }, [output]);

  const send = useCallback(async () => {
    if (!prompt.trim() || loading) {
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setOutput("");
    setMeta("");
    setActiveProvider(null);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: prompt.trim() }],
          provider: selectedProvider ?? undefined,
          apiKeys: keys,
          settings,
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(await response.text());
      }

      const provider = response.headers.get("X-Provider-Id");
      const model = response.headers.get("X-Model");
      if (provider) {
        setActiveProvider(provider as ProviderId);
      }
      if (provider && model) {
        setMeta(`${provider} · ${model}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        text += decoder.decode(value, { stream: true });
        setOutput(text);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
      setOutput(error instanceof Error ? error.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }, [keys, loading, prompt, selectedProvider, settings]);

  const stop = () => {
    abortRef.current?.abort();
    setLoading(false);
  };

  return (
    <Page
      title="Chat"
      description="Streaming chat via the MultipleAI router. Keys stay encrypted locally; decrypted only for each request."
    >
      <ProviderRail
        selectedProvider={selectedProvider}
        activeProvider={activeProvider}
        onSelect={setSelectedProvider}
      />

      <div className="card">
        <label>
          Vault passphrase
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Unlock local key vault"
          />
        </label>
      </div>

      <div className="card">
        <textarea
          rows={4}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Ask anything..."
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              void send();
            }
          }}
        />
        <div className="actions">
          <button type="button" onClick={() => void send()} disabled={loading || !prompt}>
            {loading ? "Streaming..." : "Send"}
          </button>
          {loading ? (
            <button type="button" className="secondary" onClick={stop}>
              Stop
            </button>
          ) : null}
        </div>
      </div>

      {meta ? <p className="meta">{meta}</p> : null}
      <div ref={outputRef} className="output">
        {output}
      </div>
    </Page>
  );
}
