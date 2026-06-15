import type { RefObject } from "react";

export interface TerminalSession {
  dispose(): void;
}

export async function mountTerminal(
  container: RefObject<HTMLElement | null>,
  options?: { shell?: string },
): Promise<TerminalSession> {
  if (!container.current) {
    throw new Error("Terminal container is not mounted.");
  }

  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
  ]);

  const term = new Terminal({
    cursorBlink: true,
    fontFamily: "JetBrains Mono, Menlo, monospace",
    fontSize: 13,
    theme: {
      background: "#0b0f14",
      foreground: "#e8eef5",
      cursor: "#67e8f9",
    },
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(container.current);
  fitAddon.fit();

  term.writeln("MultipleAI terminal scaffold");
  term.writeln("Wire tauri-pty spawn() here when running inside Tauri.");

  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    try {
      const { spawn } = await import("tauri-pty");
      const shell =
        options?.shell ??
        (navigator.userAgent.includes("Windows") ? "powershell.exe" : "/bin/zsh");

      const pty = spawn(shell, [], {
        cols: term.cols,
        rows: term.rows,
      });

      pty.onData((data) => term.write(data));
      term.onData((data) => pty.write(data));

      const resizeObserver = new ResizeObserver(() => {
        fitAddon.fit();
        pty.resize(term.cols, term.rows);
      });
      resizeObserver.observe(container.current);

      return {
        dispose() {
          resizeObserver.disconnect();
          pty.kill();
          term.dispose();
        },
      };
    } catch {
      term.writeln("tauri-pty unavailable — showing xterm.js stub only.");
    }
  }

  term.write("$ echo MultipleAI\r\n");
  term.write("MultipleAI\r\n");
  term.write("$ ");

  return {
    dispose() {
      term.dispose();
    },
  };
}
