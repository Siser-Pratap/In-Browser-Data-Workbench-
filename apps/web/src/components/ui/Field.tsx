'use client';

import { useId } from 'react';

import { cn } from '@/lib/utils/cn';

const CONTROL =
  'w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-ink)] ' +
  'focus-visible:border-[var(--color-accent)] focus-visible:outline-none';

/**
 * Label-plus-control pairs.
 *
 * The label is wired to the control by a generated id rather than by wrapping,
 * so a hint or an error message can sit between them without breaking the
 * association a screen reader relies on.
 */
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: (props: { id: string; className: string }) => React.ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-xs font-medium">
        {label}
      </label>
      {children({ id, className: cn(CONTROL, error && 'border-[var(--color-danger)]') })}
      {error ? (
        <p className="mt-1 text-xs text-[var(--color-danger)]">{error}</p>
      ) : (
        hint && <p className="mt-1 text-xs text-[var(--color-ink-muted)]">{hint}</p>
      )}
    </div>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(CONTROL, props.className)} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cn(CONTROL, props.className)} />;
}

export { CONTROL as CONTROL_CLASS };
