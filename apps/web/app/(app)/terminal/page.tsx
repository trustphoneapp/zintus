"use client";

import { useEffect, useRef, useState } from "react";
import { PROVIDERS } from "@/lib/providers";
import { useAppStore } from "@/lib/app-store";
import { streamChat } from "@/lib/chat-client";
import {
  getGatewayUrl,
  fetchGatewayModels,
  fetchGatewayThreads,
} from "@/lib/gateway";
import { useSettingsStore, useProviderStatusStore } from "@/lib/store";

const COMMANDS = `Commands (run against the gateway — work on any OS, any browser):
  help                 Show this help
  status               Provider availability + quota
  keys                 Which providers have a key configured
  models               Models the gateway exposes
  history              Saved conversation threads
  trace                Routing waterfall for the last request
  gateway              Gateway URL + connection state
  chat <message>       Send a chat (or just type a message)
  clear                Clear the screen
  version              CLI/console version

This mirrors the \`zintus\` CLI. Native key management (keys set/remove,
config, setup) lives in the CLI — it needs the OS keychain.`;

export default function TerminalPage() {
  const {
    terminalLines,
    pushTerminalLine,
    clearTerminal,
    loadLastTrace,
    gatewayConnected,
    gatewayProviders,
  } = useAppStore();
  const { settings, hydrate } = useSettingsStore();
  const { keys } = useProviderStatusStore();
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number>(-1);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [terminalLines]);

  function print(text: string, tone: Parameters<typeof pushTerminalLine>[0]["tone"] = "default") {
    for (const line of text.split("\n")) {
      pushTerminalLine({ text: line || " ", tone });
    }
  }

  function showStatus() {
    if (!gatewayConnected) {
      print("Gateway offline. Start it: bun run dev:gateway", "warning");
      return;
    }
    print("PROVIDER      KEY   AVAILABLE   QUOTA", "muted");
    for (const provider of PROVIDERS) {
      const status = gatewayProviders.find((item) => item.id === provider.id);
      const key = status?.hasKey ? "yes" : "—";
      const available = status?.available ? "yes" : "no";
      const quota =
        status?.quotaLimit != null && status?.quotaUsed != null
          ? `${status.quotaUsed.toLocaleString()}/${status.quotaLimit.toLocaleString()}`
          : "—";
      print(
        `${provider.name.padEnd(13)} ${key.padEnd(5)} ${available.padEnd(11)} ${quota}`,
        status?.available ? "success" : "default",
      );
    }
  }

  function showKeys() {
    const configured = PROVIDERS.filter((provider) =>
      gatewayProviders.find((item) => item.id === provider.id && item.hasKey),
    );
    if (configured.length === 0) {
      print("No provider keys configured. Add one with the CLI:", "muted");
      print("  zintus keys set groq <your-key>", "code");
      return;
    }
    print(`Configured providers (${configured.length}):`, "accent");
    for (const provider of configured) {
      print(`  ● ${provider.name}`, "default");
    }
  }

  async function runCommand(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) {
      return;
    }
    pushTerminalLine({ text: `$ ${trimmed}`, tone: "default" });
    historyRef.current.push(trimmed);
    historyIndexRef.current = historyRef.current.length;

    const [command, ...rest] = trimmed.split(/\s+/);
    const arg = rest.join(" ");
    const normalized = (command ?? "").toLowerCase();

    switch (normalized) {
      case "help":
      case "?":
        print(COMMANDS, "muted");
        return;
      case "clear":
      case "cls":
        clearTerminal();
        return;
      case "version":
        print("zintus console 0.0.1", "muted");
        return;
      case "gateway":
        print(
          `${getGatewayUrl()} — ${gatewayConnected ? "connected" : "offline"}`,
          gatewayConnected ? "success" : "warning",
        );
        return;
      case "status":
      case "providers":
        showStatus();
        return;
      case "keys":
        showKeys();
        return;
      case "models": {
        setRunning(true);
        const models = await fetchGatewayModels();
        setRunning(false);
        if (!models) {
          print("Could not reach the gateway.", "warning");
          return;
        }
        print(`${models.length} models:`, "accent");
        for (const model of models) {
          print(`  ${model}`, "default");
        }
        return;
      }
      case "history": {
        setRunning(true);
        const threads = await fetchGatewayThreads();
        setRunning(false);
        if (!threads) {
          print("Could not reach the gateway.", "warning");
          return;
        }
        if (threads.length === 0) {
          print("No saved threads yet.", "muted");
          return;
        }
        print(`${threads.length} threads:`, "accent");
        for (const thread of threads) {
          print(`  ${thread.id.slice(0, 8)}  ${thread.title}`, "default");
        }
        return;
      }
      case "trace":
        await loadLastTrace();
        return;
      case "chat":
        await runChat(arg || "");
        return;
      default:
        // Anything else is treated as a chat prompt, matching the old behavior.
        await runChat(trimmed);
    }
  }

  async function runChat(message: string) {
    if (!message.trim()) {
      print("Usage: chat <message>", "muted");
      return;
    }
    setRunning(true);
    print("→ routing…", "accent");
    try {
      let output = "";
      const result = await streamChat({
        messages: [{ role: "user", content: message }],
        apiKeys: keys,
        settings,
        onChunk: (text) => {
          output = text;
        },
      });
      print(`→ ${result.providerId} · ${result.model} (${result.source})`, "success");
      print(output, "default");
      print(`⟨ ${output.length} chars · ${result.providerId} ⟩`, "muted");
      if (result.source === "gateway") {
        await loadLastTrace();
      }
    } catch (error) {
      print(error instanceof Error ? error.message : "Request failed", "warning");
    } finally {
      setRunning(false);
    }
  }

  async function handleSubmit() {
    if (running) {
      return;
    }
    const command = input;
    setInput("");
    await runCommand(command);
  }

  function handleHistory(direction: -1 | 1) {
    const history = historyRef.current;
    if (history.length === 0) {
      return;
    }
    let next = historyIndexRef.current + direction;
    next = Math.max(0, Math.min(history.length, next));
    historyIndexRef.current = next;
    setInput(next === history.length ? "" : history[next] ?? "");
  }

  return (
    <div className="screen terminal-screen">
      <div className="terminal-output">
        {terminalLines.map((line, index) => (
          <div key={`${index}-${line.text}`} className={`terminal-line ${line.tone}`}>
            {line.text || " "}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="terminal-input-row">
        <span className="terminal-prompt">$</span>
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              void handleSubmit();
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              handleHistory(-1);
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              handleHistory(1);
            }
          }}
          placeholder="type a command (try: help) or a message"
          disabled={running}
          spellCheck={false}
          autoComplete="off"
        />
      </div>
    </div>
  );
}
