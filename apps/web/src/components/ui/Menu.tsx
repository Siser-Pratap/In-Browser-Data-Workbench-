'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

import { cn } from '@/lib/utils/cn';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  icon?: React.ReactNode;
  detail?: string;
  disabled?: boolean;
  danger?: boolean;
}

interface Props {
  label: React.ReactNode;
  items: MenuItem[];
  align?: 'left' | 'right';
  className?: string;
  title?: string;
}

/**
 * A dropdown menu.
 *
 * Small enough to hand-roll rather than pull in a headless library, but not so
 * small that the behaviour is optional: arrow keys move between items, Escape
 * closes and returns focus to the trigger, and a click anywhere else dismisses
 * it. Menus that only respond to the mouse are a keyboard dead end.
 */
export function Menu({ label, items, align = 'left', className, title }: Props) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  function choose(item: MenuItem) {
    if (item.disabled) return;
    setOpen(false);
    item.onSelect();
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'Enter') {
        event.preventDefault();
        setOpen(true);
        setHighlighted(0);
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setHighlighted((current) => (current + step + items.length) % items.length);
    }
    if (event.key === 'Enter' || event.key === ' ') {
      const item = items[highlighted];
      if (item) {
        event.preventDefault();
        choose(item);
      }
    }
  }

  return (
    <div ref={container} className={cn('relative', className)} onKeyDown={onKeyDown}>
      <button
        ref={trigger}
        type="button"
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
      >
        {label}
        <ChevronDown className="size-3" />
      </button>

      {open && (
        <div
          role="menu"
          className={cn(
            'absolute z-40 mt-1 min-w-48 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] py-1 shadow-lg',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {items.map((item, index) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onPointerEnter={() => setHighlighted(index)}
              onClick={() => choose(item)}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs disabled:opacity-40',
                index === highlighted && !item.disabled && 'bg-[var(--color-surface)]',
                item.danger ? 'text-[var(--color-danger)]' : 'text-[var(--color-ink)]',
              )}
            >
              {item.icon}
              <span className="flex-1">{item.label}</span>
              {item.detail && (
                <span className="text-[10px] text-[var(--color-ink-muted)]">{item.detail}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
