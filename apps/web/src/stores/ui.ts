'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'light' | 'dark';

/** The three things the main area can be showing. */
export type View = 'data' | 'sql' | 'dashboards';

interface UiState {
  theme: Theme;
  sidebarOpen: boolean;
  historyOpen: boolean;
  view: View;
  paletteOpen: boolean;
  /** The first-run tour is shown once; this is what "once" means. */
  tourSeen: boolean;

  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
  toggleSidebar: () => void;
  toggleHistory: () => void;
  setView: (view: View) => void;
  setPaletteOpen: (open: boolean) => void;
  dismissTour: () => void;
  replayTour: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: 'dark',
      sidebarOpen: true,
      historyOpen: false,
      view: 'data',
      paletteOpen: false,
      tourSeen: false,

      toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),
      setTheme: (theme) => set({ theme }),
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
      toggleHistory: () => set((state) => ({ historyOpen: !state.historyOpen })),
      setView: (view) => set({ view }),
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      dismissTour: () => set({ tourSeen: true }),
      replayTour: () => set({ tourSeen: false }),
    }),

    {
      name: 'workbench-ui',
      // Only the user's chrome preferences. Nothing about their data goes to
      // localStorage — that lives in OPFS and never leaves the machine. The
      // palette is transient by nature and is deliberately not restored.
      partialize: (state) => ({
        theme: state.theme,
        sidebarOpen: state.sidebarOpen,
        historyOpen: state.historyOpen,
        view: state.view,
        tourSeen: state.tourSeen,
      }),
    },
  ),
);
