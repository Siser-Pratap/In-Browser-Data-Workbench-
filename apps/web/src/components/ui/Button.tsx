'use client';

import { Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils/cn';

type Variant = 'primary' | 'ghost' | 'outline' | 'danger';
type Size = 'sm' | 'md';

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Shows a spinner and disables the button. */
  busy?: boolean;
  icon?: React.ReactNode;
}

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-[var(--color-accent)] text-[var(--color-accent-ink)] hover:opacity-90 disabled:opacity-50',
  ghost:
    'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)] disabled:opacity-40',
  outline:
    'border border-[var(--color-border)] text-[var(--color-ink)] hover:bg-[var(--color-surface)] disabled:opacity-40',
  danger: 'text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10 disabled:opacity-40',
};

const SIZES: Record<Size, string> = {
  sm: 'px-2 py-1 text-xs gap-1',
  md: 'px-3 py-1.5 text-sm gap-2',
};

export function Button({
  variant = 'ghost',
  size = 'md',
  busy = false,
  icon,
  className,
  children,
  disabled,
  ...rest
}: Props) {
  return (
    <button
      type="button"
      disabled={disabled || busy}
      className={cn(
        'inline-flex items-center justify-center rounded-md font-medium whitespace-nowrap',
        // A visible focus ring on every control is what makes keyboard-only
        // navigation of the workbench possible at all.
        'focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-canvas)] focus-visible:outline-none',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {busy ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : icon}
      {children}
    </button>
  );
}
