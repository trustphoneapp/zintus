"use client";

import { useEffect, useRef } from "react";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function defaultShell(): string {
  return navigator.platform.toLowerCase().includes("win") ? "powershell.exe" : "/bin/zsh";
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
        term.loadAddon(new WebglAddon());
      } catch {
        // WebGL unavailable — canvas fallback
      }

      term.open(container);
      fit.fit();
      term.focus();

      let resizeObserver: ResizeObserver | undefined;

      if (isTauriRuntime()) {
        try {
          const { spawn } = await import("tauri-pty");
          const pty = spawn(defaultShell(), [], { cols: term.cols, rows: term.rows });

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
        } catch {
          term.writeln("PTY plugin unavailable — check src-tauri Cargo.toml.\r\n");
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
