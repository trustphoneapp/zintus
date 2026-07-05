"use client";

import { useEffect, useState } from "react";

/**
 * Windows caption buttons (minimize / maximize-restore / close) for the
 * undecorated Windows build (tauri.windows.conf.json sets decorations:false —
 * R1: Tauri's Overlay titlebar is macOS-only, so Windows draws its own).
 * Rendered on every platform but displayed only under
 * `:root[data-platform="windows"]` (globals.css), so there is no mount flash
 * and no hydration branch. Metrics follow Fluent caption conventions (46×32
 * hit targets, centered 10px glyphs — R4); colors stay Zintus, except the
 * conventional red close hover.
 */

type TauriWindow = {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  onResized: (cb: () => void) => Promise<() => void>;
};

async function currentWindow(): Promise<TauriWindow | null> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow();
  } catch {
    return null; // plain-browser dev (next dev without tauri)
  }
}

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    // The buttons are display:none off-Windows; skip the API round-trips too.
    if (document.documentElement.dataset["platform"] !== "windows") return;
    let active = true;
    let unlisten: (() => void) | undefined;
    (async () => {
      const win = await currentWindow();
      if (!win || !active) return;
      const refresh = async () => {
        try {
          const value = await win.isMaximized();
          if (active) setMaximized(value);
        } catch {
          /* window is closing */
        }
      };
      await refresh();
      try {
        unlisten = await win.onResized(refresh);
      } catch {
        /* event permission missing — icon just won't flip; buttons still work */
      }
    })();
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const run = (action: (win: TauriWindow) => Promise<void>) => async () => {
    const win = await currentWindow();
    if (!win) return;
    try {
      await action(win);
    } catch {
      /* denied/closing — nothing sensible to surface on a caption button */
    }
  };

  return (
    <div className="win-controls">
      <button
        type="button"
        className="win-control"
        aria-label="Minimize"
        onClick={run((win) => win.minimize())}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button
        type="button"
        className="win-control"
        aria-label={maximized ? "Restore" : "Maximize"}
        onClick={run((win) => win.toggleMaximize())}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" />
            <path d="M2.5 2.5v-2h7v7h-2" fill="none" stroke="currentColor" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className="win-control win-control-close"
        aria-label="Close"
        onClick={run((win) => win.close())}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  );
}
