'use client';

import { useCallback, useRef, useState } from 'react';

interface Props {
  top: React.ReactNode;
  bottom: React.ReactNode;
  /** Starting share of the height given to the top pane, 0–1. */
  initial?: number;
  min?: number;
  max?: number;
  label?: string;
}

/**
 * A draggable horizontal split.
 *
 * Editor-over-results is a layout people rearrange constantly — a long query
 * wants height, a wide result wants the opposite. The divider is a real
 * `separator` with arrow-key support rather than a mouse-only handle, since
 * "make the results taller" shouldn't require a pointing device.
 */
export function SplitPane({
  top,
  bottom,
  initial = 0.4,
  min = 0.15,
  max = 0.85,
  label = 'Resize panes',
}: Props) {
  const [fraction, setFraction] = useState(initial);
  const container = useRef<HTMLDivElement>(null);

  const clamp = useCallback(
    (value: number) => Math.min(max, Math.max(min, value)),
    [min, max],
  );

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const bounds = container.current?.getBoundingClientRect();
    if (!bounds) return;

    function onMove(move: PointerEvent) {
      setFraction(clamp((move.clientY - bounds!.top) / bounds!.height));
    }
    function onUp() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
    }
    // Held on the body so the cursor doesn't flicker back to a text caret when
    // the pointer strays off the 4px handle mid-drag.
    document.body.style.cursor = 'row-resize';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowUp') setFraction((current) => clamp(current - 0.05));
    else if (event.key === 'ArrowDown') setFraction((current) => clamp(current + 0.05));
    else return;
    event.preventDefault();
  }

  return (
    <div ref={container} className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 overflow-hidden" style={{ height: `${fraction * 100}%` }}>
        {top}
      </div>

      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label={label}
        aria-valuenow={Math.round(fraction * 100)}
        aria-valuemin={Math.round(min * 100)}
        aria-valuemax={Math.round(max * 100)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        className="h-1 shrink-0 cursor-row-resize bg-[var(--color-border)] hover:bg-[var(--color-accent)] focus-visible:bg-[var(--color-accent)] focus-visible:outline-none"
      />

      <div className="min-h-0 flex-1 overflow-hidden">{bottom}</div>
    </div>
  );
}
