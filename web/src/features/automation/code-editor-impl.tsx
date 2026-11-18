/*
 * CodeMirror 6, loaded on demand (see code-editor.tsx) so the editor lives in its own chunk.
 * Colours come from the design tokens, so one theme serves light and dark.
 */
import { useEffect, useRef } from 'react'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { python } from '@codemirror/lang-python'
import {
  HighlightStyle,
  StreamLanguage,
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
  type StreamParser,
} from '@codemirror/language'
import { json } from '@codemirror/legacy-modes/mode/javascript'
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder as placeholderExtension,
} from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import type { ScriptLanguage } from '@/lib/api/types'
import { useTheme } from '@/lib/theme'

export type EditorLanguage = ScriptLanguage | 'json'

export interface CodeEditorProps {
  value: string
  onChange?: (value: string) => void
  language: EditorLanguage
  readOnly?: boolean
  /** CSS height of the editor, e.g. "520px" or "100%". */
  height?: string
  minHeight?: string
  wrap?: boolean
  placeholder?: string
  ariaLabel?: string
  onCursor?: (position: { line: number; column: number; lines: number }) => void
  className?: string
}

const BATCH_KEYWORDS = new Set(
  'echo set setlocal endlocal if else for in do goto call exit not exist defined errorlevel equ neq lss leq gtr geq shift pushd popd cd chdir del erase copy xcopy robocopy move mkdir md rmdir rd start title pause choice timeout reg sc net netsh ipconfig wmic findstr find type'.split(
    ' ',
  ),
)

/** A small Windows batch (cmd) mode: there is no first-party or legacy one. */
const batch: StreamParser<{ label: boolean }> = {
  name: 'batch',
  startState: () => ({ label: false }),
  token(stream) {
    if (stream.sol() && stream.match(/^\s*(?:rem\b|::).*$/i)) return 'comment'
    if (stream.eatSpace()) return null
    if (stream.sol() && stream.match(/^:[A-Za-z_][\w-]*/)) return 'labelName'
    if (
      stream.match(/^%%~?[A-Za-z]/) ||
      stream.match(/^%~?\d/) ||
      stream.match(/^%[A-Za-z_][\w]*(?::[^%]*)?%/) ||
      stream.match(/^![A-Za-z_][\w]*!/)
    )
      return 'variableName'
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return 'string'
    if (stream.match(/^@/)) return 'meta'
    if (stream.match(/^\d+\b/)) return 'number'
    if (stream.match(/^(?:==|>>|2>&1|[|&<>])/)) return 'operator'
    if (stream.match(/^[\w.-]+/)) return BATCH_KEYWORDS.has(stream.current().toLowerCase()) ? 'keyword' : null
    stream.next()
    return null
  },
}

const LANGUAGES: Record<EditorLanguage, () => Extension> = (() => {
  const ps = StreamLanguage.define(powerShell)
  const sh = StreamLanguage.define(shell)
  const cmd = StreamLanguage.define(batch)
  const js = StreamLanguage.define(json)
  const py = python()
  return {
    powershell: () => ps,
    pwsh: () => ps,
    bash: () => sh,
    sh: () => sh,
    zsh: () => sh,
    cmd: () => cmd,
    python: () => py,
    json: () => js,
  }
})()

const highlight = HighlightStyle.define([
  {
    tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier],
    color: 'var(--chart-4)',
    fontWeight: '500',
  },
  { tag: [t.string, t.special(t.string), t.character, t.regexp], color: 'var(--success)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--warning)' },
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: 'var(--subtle-foreground)',
    fontStyle: 'italic',
  },
  { tag: [t.variableName, t.special(t.variableName)], color: 'var(--info)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.labelName], color: 'var(--primary)' },
  { tag: [t.definition(t.variableName), t.propertyName, t.attributeName], color: 'var(--foreground)' },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.variableName)], color: 'var(--chart-3)' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: 'var(--muted-foreground)' },
  { tag: [t.meta, t.processingInstruction, t.annotation], color: 'var(--chart-6)' },
  { tag: t.invalid, color: 'var(--critical)' },
])

const theme = EditorView.theme({
  '&': {
    color: 'var(--foreground)',
    backgroundColor: 'var(--surface-1)',
    fontSize: '12.5px',
    height: '100%',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.7', fontFeatureSettings: '"calt" 1, "liga" 0' },
  '.cm-content': { caretColor: 'var(--primary)', padding: '10px 0' },
  '.cm-line': { padding: '0 14px 0 10px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--primary)', borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    {
      backgroundColor: 'color-mix(in oklch, var(--primary) 22%, transparent)',
    },
  '.cm-gutters': {
    backgroundColor: 'var(--surface-1)',
    color: 'color-mix(in oklch, var(--subtle-foreground) 80%, transparent)',
    border: 'none',
    borderRight: '1px solid var(--border)',
    fontVariantNumeric: 'tabular-nums',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 14px', minWidth: '40px' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--foreground)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklch, var(--foreground) 3.5%, transparent)' },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 4px', color: 'var(--subtle-foreground)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in oklch, var(--live) 18%, transparent)',
    outline: '1px solid color-mix(in oklch, var(--live) 45%, transparent)',
    borderRadius: '2px',
  },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in oklch, var(--info) 14%, transparent)' },
  '.cm-searchMatch': {
    backgroundColor: 'color-mix(in oklch, var(--warning) 25%, transparent)',
    outline: '1px solid color-mix(in oklch, var(--warning) 50%, transparent)',
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'color-mix(in oklch, var(--primary) 30%, transparent)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--surface-3)',
    border: '1px solid var(--border-strong)',
    color: 'var(--muted-foreground)',
    borderRadius: '4px',
    padding: '0 4px',
  },
  '.cm-placeholder': { color: 'var(--subtle-foreground)' },
  '.cm-panels': {
    backgroundColor: 'var(--surface-2)',
    color: 'var(--foreground)',
    fontFamily: 'var(--font-sans)',
    fontSize: '12px',
  },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-panel.cm-search': { padding: '6px 10px' },
  '.cm-panel input, .cm-panel button, .cm-textfield': {
    backgroundColor: 'var(--surface-1)',
    color: 'var(--foreground)',
    border: '1px solid var(--input)',
    borderRadius: '5px',
    fontSize: '12px',
    padding: '2px 6px',
  },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--surface-3)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--popover)',
    color: 'var(--popover-foreground)',
    border: '1px solid var(--border-strong)',
    borderRadius: '6px',
  },
})

export default function CodeEditorImpl({
  value,
  onChange,
  language,
  readOnly = false,
  height = '480px',
  minHeight,
  wrap = false,
  placeholder,
  ariaLabel,
  onCursor,
  className,
}: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const callbacks = useRef({ onChange, onCursor })
  const compartments = useRef({
    language: new Compartment(),
    readOnly: new Compartment(),
    wrap: new Compartment(),
    dark: new Compartment(),
  })
  const { resolved } = useTheme()

  useEffect(() => {
    callbacks.current = { onChange, onCursor }
  })

  useEffect(() => {
    const { language: languageSlot, readOnly: readOnlySlot, wrap: wrapSlot, dark } = compartments.current
    const report = (state: EditorState) => {
      const head = state.selection.main.head
      const line = state.doc.lineAt(head)
      callbacks.current.onCursor?.({ line: line.number, column: head - line.from + 1, lines: state.doc.lines })
    }
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        foldGutter(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        indentUnit.of('    '),
        EditorState.tabSize.of(4),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          indentWithTab,
        ]),
        syntaxHighlighting(highlight),
        theme,
        dark.of(EditorView.darkTheme.of(resolved === 'dark')),
        languageSlot.of(LANGUAGES[language]()),
        readOnlySlot.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
        wrapSlot.of(wrap ? EditorView.lineWrapping : []),
        placeholder ? placeholderExtension(placeholder) : [],
        EditorView.contentAttributes.of({
          'aria-label': ariaLabel ?? 'Code editor',
          spellcheck: 'false',
          autocapitalize: 'off',
          autocorrect: 'off',
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) callbacks.current.onChange?.(update.state.doc.toString())
          if (update.docChanged || update.selectionSet) report(update.state)
        }),
      ],
    })
    const editor = new EditorView({ state, parent: host.current! })
    view.current = editor
    report(state)
    return () => {
      editor.destroy()
      view.current = null
    }
    // The editor is created once; later prop changes are applied through compartments below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const editor = view.current
    if (!editor) return
    const current = editor.state.doc.toString()
    if (current !== value) editor.dispatch({ changes: { from: 0, to: current.length, insert: value } })
  }, [value])

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.current.language.reconfigure(LANGUAGES[language]()) })
  }, [language])

  useEffect(() => {
    view.current?.dispatch({
      effects: compartments.current.readOnly.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    })
  }, [readOnly])

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.current.wrap.reconfigure(wrap ? EditorView.lineWrapping : []) })
  }, [wrap])

  useEffect(() => {
    view.current?.dispatch({
      effects: compartments.current.dark.reconfigure(EditorView.darkTheme.of(resolved === 'dark')),
    })
  }, [resolved])

  return <div ref={host} className={className} style={{ height, minHeight }} />
}
