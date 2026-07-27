'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /** Shown instead of the crash screen, if provided. */
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Stops one broken panel from taking the whole workbench down.
 *
 * Worth having specifically because this app runs a lot of code it can't fully
 * predict — a malformed file, an unsupported Arrow type — and losing the loaded
 * datasets to a render error would mean re-importing everything.
 *
 * Class component because React has no hook equivalent for error boundaries.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled UI error:', error, info.componentStack);
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <h2 className="text-lg font-semibold text-[var(--color-ink)]">Something broke</h2>
        <p className="max-w-md text-sm text-[var(--color-ink-muted)]">{error.message}</p>
        <p className="max-w-md text-xs text-[var(--color-ink-muted)]">
          Your imported data is still loaded — this only affects the view.
        </p>
        <button
          type="button"
          onClick={this.reset}
          className="mt-2 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[var(--color-accent-ink)] hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }
}
