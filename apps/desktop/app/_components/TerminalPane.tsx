"use client";

import { useEffect, useRef } from "react";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Resolve the shell from the Rust backend (honors $SHELL / COMSPEC and the OS).
 * Falls back to a per-OS guess only if the command is unavailable.
 */
async function resolveShell(): Promise<string> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const shell = await invoke<string>("default_shell");
    if (shell) {
      return shell;
    }
  } catch (error) {
    console.error("[terminal] default_shell command failed:", error);
  }
  if (navigator.userAgent.includes("Windows")) {
    return "powershell.exe";
  }
  return navigator.userAgent.includes("Mac") ? "/bin/zsh" : "/bin/bash";
}

export function TerminalPane() {
  const termRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;

    async function init() {
      const [{ Terminal }, { FitAddon }, { WebglAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-webgl"),
      ]);
      await import("@xterm/xterm/css/xterm.css");

      const container = termRef.current;
      if (!container || disposed) {
        return;
      }

      const term = new Terminal({
        cursorBlink: true,
        fontFamily: "var(--font-mono)",
        fontSize: 13,
        lineHeight: 1.6,
        theme: {
          background: "#0D0B14",
          foreground: "#F1EEF8",
          cursor: "#A855F7",
          cursorAccent: "#0D0B14",
        },
      });

      const fit = new FitAddon();
      term.loadAddon(fit);

      try {
        const webgl = new WebglAddon();
        // On some Linux/VM/headless GPUs the context is lost after load rather
        // than throwing — dispose so xterm falls back to the DOM renderer.
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // WebGL unavailable at construction — DOM renderer used
      }

      term.open(container);
      fit.fit();
      term.focus();

      let resizeObserver: ResizeObserver | undefined;

      if (isTauriRuntime()) {
        try {
          const { spawn } = await import("tauri-pty");
          const shell = await resolveShell();
          const pty = spawn(shell, [], { cols: term.cols, rows: term.rows });

          pty.onData((data) => {
            const text =
              typeof data === "string" ? data : new TextDecoder().decode(data);
            term.write(text);
          });
          term.onData((data) => pty.write(data));

          resizeObserver = new ResizeObserver(() => {
            fit.fit();
            pty.resize(term.cols, term.rows);
          });
          resizeObserver.observe(container);

          term.writeln("\x1b[35mMultipleAI\x1b[0m terminal — tauri-plugin-pty\r\n");

          cleanup = () => {
            resizeObserver?.disconnect();
            pty.kill();
            term.dispose();
          };
        } catch (error) {
          console.error("[terminal] PTY init failed:", error);
          const detail = error instanceof Error ? error.message : String(error);
          term.writeln(`PTY unavailable: ${detail}\r\n`);
        }
      } else {
        term.writeln("MultipleAI terminal preview (browser dev mode).\r\n");
        term.writeln("Run `bun tauri dev` for a real shell.\r\n");
        term.write("$ ");
        term.onData((data) => {
          if (data === "\r") {
            term.write("\r\n$ ");
          } else {
            term.write(data);
          }
        });
      }

      if (!cleanup) {
        resizeObserver = new ResizeObserver(() => fit.fit());
        resizeObserver.observe(container);
        cleanup = () => {
          resizeObserver?.disconnect();
          term.dispose();
        };
      }
    }

    void init().then(() => {
      if (disposed) {
        cleanup?.();
      }
    });

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  return (
    <div
      ref={termRef}
      style={{
        flex: 1,
        minHeight: 0,
        background: "#0D0B14",
        margin: 16,
        borderRadius: 8,
        border: "1px solid var(--color-border)",
        overflow: "hidden",
      }}
    />
  );
}
