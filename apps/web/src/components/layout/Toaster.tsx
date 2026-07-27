'use client';

import { Toaster as Sonner } from 'sonner';

import { useUiStore } from '@/stores/ui';

export function Toaster() {
  const theme = useUiStore((state) => state.theme);
  return <Sonner theme={theme} position="bottom-right" closeButton richColors />;
}
