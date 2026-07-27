'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Theme = 'light' | 'dark';

interface UiState {
  theme: Theme;
  sidebarOpen: boolean;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
  toggleSidebar: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: 'dark',
      sidebarOpen: true,
      toggleTheme: () => set((state) => ({ theme: state.theme === 'dark' ? 'light' : 'dark' })),
      setTheme: (theme) => set({ theme }),
      toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
    }),
    {
      name: 'workbench-ui',
      // Only the user's chrome preferences. Nothing about their data goes to
      // localStorage — that lives in OPFS and never leaves the machine.
      partialize: (state) => ({ theme: state.theme, sidebarOpen: state.sidebarOpen }),
    },
  ),
);
