'use client';

import { useEffect } from 'react';

import { useUiStore } from '@/stores/ui';

/**
 * Mirrors the theme from the store onto <html>.
 *
 * The inline script in layout.tsx sets the initial class before paint; this
 * keeps it in sync afterwards, when the user toggles.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const theme = useUiStore((state) => state.theme);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  return <>{children}</>;
}
