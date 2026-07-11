"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTheme } from "next-themes";

type Mode = {
  /** next-themes value this segment selects. */
  id: string;
  label: string;
  /** Swatch: the mode's canvas colour (hardcoded per mode). */
  canvas: string;
  /** Swatch: the mode's accent colour (hardcoded per mode). */
  accent: string;
};

// Order matches the segmented pill left→right. The sliding thumb translates by
// its own width (one segment) per index, so this order IS the visual order.
const DARK_MODES: Mode[] = [
  { id: "obsidian", label: "Obsidian", canvas: "#060607", accent: "#f5f5f7" },
  { id: "indigo", label: "Indigo", canvas: "#0c0c0f", accent: "#4d6bfe" },
  { id: "graphite", label: "Graphite", canvas: "#0f1110", accent: "#20a8b8" },
];

// The app shell keeps its warm-white light theme as a fourth choice
// (marketing is dark-only, so it only renders the three dark modes).
const LIGHT_MODE: Mode = {
  id: "light",
  label: "Light",
  canvas: "#faf9f7",
  accent: "#1a1a1e",
};

// Indigo is the default: `dark`, `indigo`, `undefined` — and `light` when the
// light segment isn't offered — all read as Indigo-active.
function activeIndex(modes: Mode[], resolvedTheme: string | undefined): number {
  const explicit = modes.findIndex((mode) => mode.id === resolvedTheme);
  if (explicit !== -1) return explicit;
  return modes.findIndex((mode) => mode.id === "indigo");
}

export function ModeSwitcher({ withLight = false }: { withLight?: boolean }) {
  const modes = withLight ? [LIGHT_MODE, ...DARK_MODES] : DARK_MODES;
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Mounted-guard: resolvedTheme is only known client-side, so we render a
  // stable Indigo-selected pill on the server and first paint to avoid a
  // hydration mismatch (same pattern as the old ThemeToggle).
  useEffect(() => setMounted(true), []);

  const index = mounted
    ? activeIndex(modes, resolvedTheme)
    : activeIndex(modes, undefined);

  function select(i: number) {
    const mode = modes[((i % modes.length) + modes.length) % modes.length];
    if (mode) setTheme(mode.id);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, i: number) {
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = (i + 1) % modes.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = (i - 1 + modes.length) % modes.length;
    }
    if (next === null) return;
    event.preventDefault();
    select(next);
    btnRefs.current[next]?.focus();
  }

  return (
    <div className="mode-switcher" role="radiogroup" aria-label="Colour mode">
      <span
        className="mode-switcher-thumb"
        aria-hidden="true"
        style={{ transform: `translateX(${index * 100}%)` }}
      />
      {modes.map((mode, i) => {
        const checked = mounted && i === index;
        return (
          <button
            key={mode.id}
            ref={(el) => {
              btnRefs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={`${mode.label} mode`}
            tabIndex={i === index ? 0 : -1}
            className={`mode-switcher-opt${checked ? " active" : ""}`}
            title={`${mode.label} mode`}
            onClick={() => select(i)}
            onKeyDown={(event) => onKeyDown(event, i)}
          >
            <span className="mode-switcher-swatch" aria-hidden="true">
              <span style={{ background: mode.canvas }} />
              <span style={{ background: mode.accent }} />
            </span>
            <span className="mode-switcher-label">{mode.label}</span>
          </button>
        );
      })}
    </div>
  );
}
