'use client';

import { useEffect, useRef, useState } from 'react';
import type * as MonacoApi from 'monaco-editor';

import { setActiveEditor } from '@/lib/editor/bridge';
import { loadMonaco, SQL_LANGUAGE_ID, themeFor, type Monaco } from '@/lib/editor/monaco';
import { completionsFor, type CompletionKind } from '@/lib/sql/completion';
import type { ParsedSqlError } from '@/lib/sql/errors';
import { useCatalogStore } from '@/stores/catalog';
import { useHistoryStore } from '@/stores/history';
import { useUiStore } from '@/stores/ui';

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** Run — with the selected text when there is a selection, else the buffer. */
  onRun: (selection?: string) => void;
  onFormat: () => void;
  error?: ParsedSqlError | null;
}

/**
 * The SQL editor.
 *
 * Monaco is created imperatively and never re-created: it owns its own DOM and
 * its own undo stack, and letting React tear it down on a re-render would lose
 * both. The component's job is only to keep the model in sync with props and to
 * route keyboard shortcuts back out.
 */
export function SqlEditor({ value, onChange, onRun, onFormat, error }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoApi.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const [ready, setReady] = useState(false);
  const theme = useUiStore((state) => state.theme);

  // Callbacks reach the Monaco keybindings through a ref: the commands are
  // registered once at creation, so capturing the first render's props would
  // pin `onRun` to a stale tab forever.
  const handlers = useRef({ onChange, onRun, onFormat });
  useEffect(() => {
    handlers.current = { onChange, onRun, onFormat };
  });

  useEffect(() => {
    let editor: MonacoApi.editor.IStandaloneCodeEditor | null = null;
    let completion: MonacoApi.IDisposable | null = null;
    let cancelled = false;

    void loadMonaco().then((monaco) => {
      if (cancelled || !container.current) return;
      monacoRef.current = monaco;

      editor = monaco.editor.create(container.current, {
        value,
        language: SQL_LANGUAGE_ID,
        theme: themeFor(theme),
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        scrollBeyondLastLine: false,
        renderLineHighlight: 'line',
        padding: { top: 10, bottom: 10 },
        tabSize: 2,
        wordWrap: 'on',
        suggestSelection: 'first',
        quickSuggestions: { other: true, comments: false, strings: false },
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      });
      editorRef.current = editor;
      setActiveEditor(editor);

      editor.onDidChangeModelContent(() => {
        handlers.current.onChange(editor?.getValue() ?? '');
      });
      editor.onDidFocusEditorText(() => setActiveEditor(editor));

      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
        // Running a selection is how you test one CTE without deleting the rest
        // of the query, so the selection wins whenever there is one.
        const selection = editor?.getSelection();
        const selected =
          selection && !selection.isEmpty()
            ? editor?.getModel()?.getValueInRange(selection)
            : undefined;
        handlers.current.onRun(selected?.trim() || undefined);
      });
      editor.addCommand(
        monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF,
        () => handlers.current.onFormat(),
      );

      completion = registerCompletions(monaco);
      setReady(true);
    });

    return () => {
      cancelled = true;
      completion?.dispose();
      setActiveEditor(null);
      editor?.getModel()?.dispose();
      editor?.dispose();
      editorRef.current = null;
    };
    // Created once for the life of the component; the tab key on <SqlEditor>
    // is what gives each tab its own editor and its own undo history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push external edits (Format, "open in editor", a restored tab) into the
  // model — but only when they really differ, or every keystroke would round-
  // trip through React and reset the cursor.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || editor.getValue() === value) return;
    editor.executeEdits('external', [
      { range: editor.getModel()!.getFullModelRange(), text: value, forceMoveMarkers: true },
    ]);
    editor.pushUndoStop();
  }, [value, ready]);

  useEffect(() => {
    monacoRef.current?.editor.setTheme(themeFor(theme));
  }, [theme, ready]);

  // Underline the exact token DuckDB objected to.
  useEffect(() => {
    const monaco = monacoRef.current;
    const model = editorRef.current?.getModel();
    if (!monaco || !model) return;

    if (!error?.position) {
      monaco.editor.setModelMarkers(model, 'duckdb', []);
      return;
    }
    const { line, column } = error.position;
    const word = model.getWordAtPosition({ lineNumber: line, column }) ?? null;
    monaco.editor.setModelMarkers(model, 'duckdb', [
      {
        severity: monaco.MarkerSeverity.Error,
        message: `${error.title}: ${error.detail}`,
        startLineNumber: line,
        startColumn: word?.startColumn ?? column,
        endLineNumber: line,
        endColumn: word?.endColumn ?? column + 1,
      },
    ]);
  }, [error, ready]);

  return (
    <div className="relative h-full w-full">
      <div ref={container} className="h-full w-full" data-testid="sql-editor" />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center bg-[var(--color-canvas)] text-xs text-[var(--color-ink-muted)]">
          Loading editor…
        </div>
      )}
    </div>
  );
}

/**
 * Register the schema-aware completion provider.
 *
 * Registration is global to the `sql` language rather than per-editor, so it's
 * guarded against double-registration: two open tabs would otherwise each add a
 * provider and every suggestion would appear twice. The catalogue is read from
 * the store at request time, so a table created a second ago is already
 * suggestible.
 */
let completionRegistered = false;

function registerCompletions(monaco: Monaco): MonacoApi.IDisposable | null {
  if (completionRegistered) return null;
  completionRegistered = true;

  const provider = monaco.languages.registerCompletionItemProvider(SQL_LANGUAGE_ID, {
    triggerCharacters: ['.', ' '],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const suggestions = completionsFor({
        sql: model.getValue(),
        offset: model.getOffsetAt(position),
        catalog: useCatalogStore.getState().tables,
        snippets: useHistoryStore.getState().snippets,
      }).map((item) => ({
        label: item.label,
        kind: MONACO_KINDS[item.kind](monaco),
        detail: item.detail,
        insertText: item.insertText ?? item.label,
        insertTextRules:
          item.kind === 'function'
            ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
            : undefined,
        // Monaco sorts by `sortText` lexically, so the numeric rank has to be
        // rendered as a digit prefix to keep tables above keywords.
        sortText: `${item.rank}${item.label}`,
        range,
      }));

      return { suggestions };
    },
  });

  return {
    dispose() {
      provider.dispose();
      completionRegistered = false;
    },
  };
}

const MONACO_KINDS: Record<CompletionKind, (monaco: Monaco) => number> = {
  table: (monaco) => monaco.languages.CompletionItemKind.Struct,
  column: (monaco) => monaco.languages.CompletionItemKind.Field,
  keyword: (monaco) => monaco.languages.CompletionItemKind.Keyword,
  function: (monaco) => monaco.languages.CompletionItemKind.Function,
  snippet: (monaco) => monaco.languages.CompletionItemKind.Snippet,
};
