import type * as MonacoApi from 'monaco-editor';

/**
 * A handle on whichever editor the user is looking at.
 *
 * The schema explorer's "click a column to insert it" and the command palette's
 * "run this snippet" both need to type into the editor, and neither is anywhere
 * near it in the component tree. Threading a ref through the layout would mean
 * every panel taking a prop it doesn't otherwise care about; a module-level
 * handle is the smaller cost. There is only ever one focused editor, so there is
 * nothing to disambiguate.
 */

let active: MonacoApi.editor.IStandaloneCodeEditor | null = null;

export function setActiveEditor(editor: MonacoApi.editor.IStandaloneCodeEditor | null): void {
  active = editor;
}

export function hasActiveEditor(): boolean {
  return active !== null;
}

/**
 * Insert text where the cursor is, replacing the selection if there is one.
 *
 * Goes through `executeEdits` rather than rewriting the model's value so the
 * change joins the editor's own undo stack — an accidental insert should be one
 * Ctrl+Z away, not a silent overwrite of the buffer.
 */
export function insertAtCursor(text: string): boolean {
  if (!active) return false;
  const selection = active.getSelection();
  if (!selection) return false;

  active.executeEdits('workbench', [{ range: selection, text, forceMoveMarkers: true }]);
  active.focus();
  return true;
}

export function focusEditor(): void {
  active?.focus();
}
