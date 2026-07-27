'use client';

import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

import { cn } from '@/lib/utils/cn';

interface Props {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Tailwind max-width class; dialogs here range from a prompt to a builder. */
  width?: string;
  description?: string;
}

/**
 * A modal dialog with the keyboard behaviour a modal is supposed to have.
 *
 * Every dialog in the app goes through this rather than hand-rolling the shell,
 * because the parts that are easy to skip are the parts that matter: focus moves
 * into the dialog on open, Tab stays inside it while it's open, Escape closes
 * it, and focus returns to whatever opened it. Without the trap, tabbing walks
 * invisibly through the workbench behind the overlay — which is both a WCAG
 * failure and genuinely confusing.
 */
export function Dialog({ title, onClose, children, footer, width = 'max-w-lg', description }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // Focus the panel itself rather than its first input: reading the title
    // before being dropped into a text field is the less disorienting order for
    // a screen reader, and typing still works after one Tab.
    panel.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panel.current) return;

      const focusable = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => !element.hasAttribute('disabled') && element.offsetParent !== null,
      );
      if (focusable.length === 0) return;

      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === panel.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      // A click on the backdrop is a dismissal; a click that started inside the
      // panel and ended on the backdrop (a drag) is not, hence `onMouseDown`.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cn(
          'flex max-h-[90vh] w-full flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] shadow-xl outline-none',
          width,
        )}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-[var(--color-border)] px-4 py-3">
          <div>
            <h2 id={titleId} className="text-sm font-semibold">
              {title}
            </h2>
            {description && (
              <p id={descriptionId} className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
                {description}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>

        {footer && (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--color-border)] px-4 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

const FOCUSABLE =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
