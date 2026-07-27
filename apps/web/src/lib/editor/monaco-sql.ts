/**
 * A SQL-only Monaco build.
 *
 * Importing `monaco-editor` directly pulls in every language it ships *and* the
 * CSS/HTML/JSON/TypeScript language services — the TypeScript one alone embeds a
 * copy of the compiler, which is several megabytes of JavaScript nobody writing
 * SQL will ever execute. This module reproduces `editor.main.js` minus those
 * four language *features* and minus the ~90 language *definitions*, then
 * registers the one language we need.
 *
 * The contribution list below is `editor.main.js`'s own, filtered. Regenerate it
 * after a Monaco upgrade with:
 *
 *   grep "^import '" node_modules/monaco-editor/esm/vs/editor/editor.main.js \
 *     | grep -v languages/definitions | grep -v languages/features
 *
 * A missing contribution shows up as a feature that silently does nothing (no
 * suggest widget, no find box), not as a crash — so it is worth re-checking the
 * editor by hand after regenerating.
 */

// The API surface: `monaco.editor`, `monaco.languages`, `monaco.KeyCode`, …
export * from 'monaco-editor/editor/editor.api.js';

// Editor contributions — everything that makes it an editor rather than a
// styled textarea. Order follows editor.main.js.
import 'monaco-editor/editor/contrib/anchorSelect/browser/anchorSelect.js';
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/editor/contrib/caretOperations/browser/transpose.js';
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/editor/contrib/codeAction/browser/codeActionContributions.js';
import 'monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget.js';
import 'monaco-editor/editor/contrib/codelens/browser/codelensController.js';
// Codicon glyphs (the suggest widget's kind icons). Reached through Monaco's
// own feature module because the package's exports map appends `.js` to every
// subpath, so a `.css` file cannot be imported by package specifier.
import 'monaco-editor/features/codicon/register.js';
import 'monaco-editor/editor/contrib/colorPicker/browser/colorPickerContribution.js';
import 'monaco-editor/editor/contrib/comment/browser/comment.js';
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js';
import 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js';
import 'monaco-editor/editor/browser/widget/diffEditor/diffEditor.contribution.js';
import 'monaco-editor/editor/contrib/diffEditorBreadcrumbs/browser/contribution.js';
import 'monaco-editor/editor/contrib/dnd/browser/dnd.js';
import 'monaco-editor/editor/contrib/documentSymbols/browser/documentSymbols.js';
import 'monaco-editor/editor/contrib/dropOrPasteInto/browser/dropIntoEditorContribution.js';
import 'monaco-editor/features/find/register.js';
import 'monaco-editor/editor/contrib/floatingMenu/browser/floatingMenu.contribution.js';
import 'monaco-editor/editor/contrib/folding/browser/folding.js';
import 'monaco-editor/editor/contrib/fontZoom/browser/fontZoom.js';
import 'monaco-editor/editor/contrib/format/browser/formatActions.js';
import 'monaco-editor/editor/contrib/gotoError/browser/gotoError.js';
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js';
import 'monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js';
import 'monaco-editor/editor/contrib/gpu/browser/gpuActions.js';
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js';
import 'monaco-editor/editor/contrib/indentation/browser/indentation.js';
import 'monaco-editor/editor/contrib/inlayHints/browser/inlayHintsContribution.js';
import 'monaco-editor/editor/contrib/inlineCompletions/browser/inlineCompletions.contribution.js';
import 'monaco-editor/editor/contrib/inlineProgress/browser/inlineProgress.js';
import 'monaco-editor/editor/contrib/inPlaceReplace/browser/inPlaceReplace.js';
import 'monaco-editor/editor/contrib/insertFinalNewLine/browser/insertFinalNewLine.js';
import 'monaco-editor/editor/standalone/browser/inspectTokens/inspectTokens.js';
import 'monaco-editor/editor/standalone/browser/iPadShowKeyboard/iPadShowKeyboard.js';
import 'monaco-editor/editor/contrib/lineSelection/browser/lineSelection.js';
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js';
import 'monaco-editor/editor/contrib/linkedEditing/browser/linkedEditing.js';
import 'monaco-editor/editor/contrib/links/browser/links.js';
import 'monaco-editor/editor/contrib/longLinesHelper/browser/longLinesHelper.js';
import 'monaco-editor/editor/contrib/middleScroll/browser/middleScroll.contribution.js';
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor.js';
import 'monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js';
import 'monaco-editor/editor/contrib/placeholderText/browser/placeholderText.contribution.js';
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js';
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneHelpQuickAccess.js';
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess.js';
import 'monaco-editor/editor/contrib/readOnlyMessage/browser/contribution.js';
import 'monaco-editor/editor/standalone/browser/referenceSearch/standaloneReferenceSearch.js';
import 'monaco-editor/editor/contrib/rename/browser/rename.js';
import 'monaco-editor/editor/contrib/sectionHeaders/browser/sectionHeaders.js';
import 'monaco-editor/editor/contrib/semanticTokens/browser/viewportSemanticTokens.js';
import 'monaco-editor/editor/contrib/smartSelect/browser/smartSelect.js';
import 'monaco-editor/editor/contrib/snippet/browser/snippetController2.js';
import 'monaco-editor/editor/contrib/stickyScroll/browser/stickyScrollContribution.js';
import 'monaco-editor/editor/contrib/suggest/browser/suggestInlineCompletions.js';
import 'monaco-editor/editor/standalone/browser/toggleHighContrast/toggleHighContrast.js';
import 'monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode.js';
import 'monaco-editor/editor/contrib/tokenization/browser/tokenization.js';
import 'monaco-editor/editor/contrib/unicodeHighlighter/browser/unicodeHighlighter.js';
import 'monaco-editor/editor/contrib/unusualLineTerminators/browser/unusualLineTerminators.js';
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js';
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js';
import 'monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations.js';
import 'monaco-editor/editor/browser/coreCommands.js';
import 'monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js';
import 'monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution.js';
import 'monaco-editor/editor/contrib/find/browser/findController.js';
import 'monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js';
import 'monaco-editor/editor/contrib/gotoError/browser/markerSelectionStatus.js';
import 'monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens.js';
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js';
import 'monaco-editor/editor/common/standaloneStrings.js';
// The modifier animations have no such feature module, so next.config.ts
// aliases this specifier straight at the file.
import 'monaco-codicon-modifiers.css';

// The only language this app edits. Its tokenizer is behind a lazy loader, so
// registering it costs nothing until a SQL model is created.
import 'monaco-editor/languages/definitions/sql/register.js';
