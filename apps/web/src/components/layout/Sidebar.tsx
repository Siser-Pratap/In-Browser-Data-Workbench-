'use client';

import { SchemaExplorer } from '@/components/schema/SchemaExplorer';
import { useUiStore } from '@/stores/ui';

export function Sidebar() {
  const open = useUiStore((state) => state.sidebarOpen);
  if (!open) return null;

  return (
    <aside className="flex w-64 shrink-0 flex-col overflow-hidden border-r border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="px-3 py-2 text-[11px] font-semibold tracking-wide text-[var(--color-ink-muted)] uppercase">
        Tables
      </div>
      <SchemaExplorer />
    </aside>
  );
}
