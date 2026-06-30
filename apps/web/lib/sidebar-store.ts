"use client";

import { create } from "zustand";

/**
 * Shared open/closed state for the app sidebar. Lives in its own store so the
 * two things that drive it from different component trees — the header hamburger
 * (in the chat header / the global topbar) and the <Sidebar> itself — read and
 * write one source of truth.
 *
 * SSR safety: `open` defaults to `true` so the server and the first client
 * render agree (full sidebar). `hydrate()` reads the persisted choice in an
 * effect afterwards, so there's no hydration mismatch. Persisted to
 * localStorage under "zintus.sidebarOpen".
 */
const STORAGE_KEY = "zintus.sidebarOpen";

interface SidebarState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** Read the persisted choice (call once from an effect after mount). */
  hydrate: () => void;
}

function persist(open: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(open));
  } catch {
    /* storage unavailable — in-memory state still works */
  }
}

export const useSidebarStore = create<SidebarState>((set) => ({
  open: true,
  setOpen: (open) => {
    persist(open);
    set({ open });
  },
  toggle: () =>
    set((state) => {
      const open = !state.open;
      persist(open);
      return { open };
    }),
  hydrate: () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw != null) set({ open: raw !== "false" });
    } catch {
      /* ignore */
    }
  },
}));
