/**
 * Loading and configuring Monaco.
 *
 * Two constraints shape this module.
 *
 * First, **nothing may come from a CDN**. The usual `@monaco-editor/react`
 * setup fetches Monaco from jsdelivr at runtime, which would break the
 * product's central claim (nothing leaves the browser), and would be blocked
 * anyway by the `Cross-Origin-Embedder-Policy: require-corp` header the page
 * sets for DuckDB. So Monaco is imported from node_modules and bundled.
 *
 * Second, it must not be in the initial bundle. Monaco is megabytes; a visitor
 * who only drops a file in and looks at the grid should never download it.
 * Hence the dynamic `import()` here, behind a memoized promise so that opening
 * three query tabs doesn't parse it three times.
 */

import type * as MonacoApi from 'monaco-editor';

/**
 * The API shape. Structurally identical to `monaco-editor`'s own namespace —
 * `monaco-sql.ts` re-exports `editor.api.js`, which is where those types come
 * from — so the published typings describe it exactly.
 */
export type Monaco = typeof MonacoApi;

export const SQL_LANGUAGE_ID = 'sql';
export const DARK_THEME = 'workbench-dark';
export const LIGHT_THEME = 'workbench-light';

let loading: Promise<Monaco> | null = null;

export function loadMonaco(): Promise<Monaco> {
  loading ??= import('./monaco-sql').then((monaco) => {
    installWorkerFactory();
    defineThemes(monaco as unknown as Monaco);
    return monaco as unknown as Monaco;
  });
  return loading;
}

/**
 * Point Monaco at its own worker, bundled from node_modules.
 *
 * Without this Monaco logs a warning and runs its text services on the main
 * thread. We only ever use the `sql` language, which has no language server —
 * so the plain editor worker is the only one needed, and the JSON/CSS/TS
 * workers are deliberately not wired up.
 */
function installWorkerFactory(): void {
  const scope = globalThis as typeof globalThis & { MonacoEnvironment?: MonacoApi.Environment };
  scope.MonacoEnvironment ??= {
    getWorker: () =>
      new Worker(new URL('monaco-editor/editor/editor.worker.js', import.meta.url), {
        type: 'module',
      }),
  };
}

/**
 * Themes matching the app palette.
 *
 * Monaco takes hex, not CSS variables, so these are a hand-transcription of the
 * `oklch` values in globals.css and have to be updated alongside them. The
 * alternative — resolving the variables at runtime — doesn't work, because
 * browsers report computed `oklch()` colours in a form Monaco won't parse.
 */
function defineThemes(monaco: Monaco): void {
  monaco.editor.defineTheme(DARK_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword.sql', foreground: '8fb6ff', fontStyle: 'bold' },
      { token: 'operator.sql', foreground: 'c7cbd6' },
      { token: 'string.sql', foreground: '9fd6a8' },
      { token: 'number', foreground: 'f0c98a' },
      { token: 'comment', foreground: '7d8496', fontStyle: 'italic' },
      { token: 'identifier.quote.sql', foreground: 'e8c98a' },
    ],
    colors: {
      'editor.background': '#1b1e26',
      'editor.foreground': '#eef0f4',
      'editorLineNumber.foreground': '#6b7385',
      'editorLineNumber.activeForeground': '#aeb6c6',
      'editor.lineHighlightBackground': '#232733',
      'editor.selectionBackground': '#2f4a7a',
      'editorCursor.foreground': '#8fb6ff',
      'editorIndentGuide.background1': '#2b303c',
      'editorWidget.background': '#232733',
      'editorWidget.border': '#343a49',
      'editorSuggestWidget.selectedBackground': '#2f4a7a',
    },
  });

  monaco.editor.defineTheme(LIGHT_THEME, {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'keyword.sql', foreground: '1d4ed8', fontStyle: 'bold' },
      { token: 'string.sql', foreground: '166534' },
      { token: 'number', foreground: '9a3412' },
      { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#2b2f36',
      'editorLineNumber.foreground': '#9aa1ad',
      'editor.lineHighlightBackground': '#f4f6f9',
      'editorCursor.foreground': '#2563eb',
    },
  });
}

export function themeFor(theme: 'light' | 'dark'): string {
  return theme === 'dark' ? DARK_THEME : LIGHT_THEME;
}
