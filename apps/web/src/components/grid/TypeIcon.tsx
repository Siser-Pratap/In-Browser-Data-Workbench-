import { Calendar, Hash, HelpCircle, ToggleLeft, Type } from 'lucide-react';

import type { ColumnKind } from '@/lib/engine/types';

const ICONS = {
  number: Hash,
  string: Type,
  date: Calendar,
  boolean: ToggleLeft,
  other: HelpCircle,
} as const satisfies Record<ColumnKind, unknown>;

const LABELS: Record<ColumnKind, string> = {
  number: 'Number',
  string: 'Text',
  date: 'Date or time',
  boolean: 'Boolean',
  other: 'Other',
};

/** The small glyph that tells you a column's kind at a glance. */
export function TypeIcon({ kind }: { kind: ColumnKind }) {
  const Icon = ICONS[kind];
  return (
    <Icon className="size-3 shrink-0 opacity-70" aria-label={LABELS[kind]} role="img" />
  );
}
