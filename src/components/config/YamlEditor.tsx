import { useMemo, type Ref } from 'react';
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { yaml } from '@codemirror/lang-yaml';
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { EditorView, keymap } from '@codemirror/view';
import { parseDocument } from 'yaml';

type YamlEditorProps = {
  value: string;
  onChange: (value: string) => void;
  editorRef?: Ref<ReactCodeMirrorRef>;
  theme: 'light' | 'dark';
  editable: boolean;
  placeholder: string;
  diagnosticSourceLabel?: string;
};

export function YamlEditor({
  value,
  onChange,
  editorRef,
  theme,
  editable,
  placeholder,
  diagnosticSourceLabel = 'YAML',
}: YamlEditorProps) {
  const yamlLinter = useMemo(
    () =>
      linter((view) => {
        let yamlDocument: ReturnType<typeof parseDocument>;
        try {
          yamlDocument = parseDocument(view.state.doc.toString());
        } catch (err: unknown) {
          return [
            {
              from: 0,
              to: Math.min(view.state.doc.length, 1),
              severity: 'error',
              source: diagnosticSourceLabel,
              message: err instanceof Error ? err.message : 'Invalid YAML',
            } satisfies Diagnostic,
          ];
        }

        return yamlDocument.errors.map((error) => {
          const from = Math.max(0, Math.min(error.pos[0] ?? 0, view.state.doc.length));
          const to = Math.max(from + 1, Math.min(error.pos[1] ?? from + 1, view.state.doc.length));
          return {
            from,
            to,
            severity: 'error',
            source: diagnosticSourceLabel,
            message: error.message,
          } satisfies Diagnostic;
        });
      }),
    [diagnosticSourceLabel]
  );

  const editorTheme = useMemo(
    () =>
      EditorView.theme(
        {
          '&': {
            backgroundColor: 'transparent',
            color: 'var(--text-primary)',
          },
          '&.cm-focused': {
            outline: 'none',
          },
          '.cm-scroller': {
            backgroundColor: 'transparent',
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Courier New', monospace",
          },
          '.cm-content': {
            caretColor: 'var(--primary-color)',
            minHeight: '100%',
            padding: '20px 0 24px',
          },
          '.cm-line': {
            padding: '0 20px',
          },
          '.cm-gutters': {
            minWidth: '58px',
            color: 'var(--text-tertiary)',
          },
          '.cm-foldGutter': {
            color: 'var(--text-muted)',
          },
          '.cm-activeLineGutter': {
            color: 'var(--text-primary)',
            fontWeight: '700',
          },
          '.cm-activeLine': {
            boxShadow: 'inset 3px 0 0 var(--primary-color)',
          },
          '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
            backgroundColor: 'color-mix(in srgb, var(--primary-color) 24%, transparent) !important',
          },
          '.cm-cursor': {
            borderLeftColor: 'var(--primary-color)',
          },
          '.cm-placeholder': {
            color: 'var(--text-tertiary)',
            fontStyle: 'normal',
          },
          '.cm-matchingBracket, .cm-nonmatchingBracket': {
            outline: '1px solid color-mix(in srgb, var(--primary-color) 34%, transparent)',
            backgroundColor: 'color-mix(in srgb, var(--primary-color) 10%, transparent)',
          },
          '.cm-tooltip': {
            border: '1px solid color-mix(in srgb, var(--danger-color) 40%, var(--border-color))',
            borderRadius: '10px',
            backgroundColor: 'var(--bg-primary)',
            boxShadow: 'var(--shadow-lg)',
            color: 'var(--text-primary)',
          },
          '.cm-diagnostic': {
            padding: '8px 10px',
          },
          '.cm-diagnostic-error': {
            borderLeft: '3px solid var(--danger-color)',
          },
          '.cm-lintRange-error': {
            backgroundImage:
              'linear-gradient(45deg, transparent 65%, var(--danger-color) 80%, transparent 90%)',
            backgroundPosition: 'left bottom',
            backgroundRepeat: 'repeat-x',
            backgroundSize: '8px 3px',
          },
          '.cm-lint-marker-error': {
            color: 'var(--danger-color)',
          },
        },
        { dark: theme === 'dark' }
      ),
    [theme]
  );

  const extensions = useMemo(
    () => [
      yaml(),
      search(),
      highlightSelectionMatches(),
      keymap.of(searchKeymap),
      EditorView.lineWrapping,
      lintGutter(),
      yamlLinter,
      editorTheme,
    ],
    [editorTheme, yamlLinter]
  );

  return (
    <CodeMirror
      ref={editorRef}
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme={theme}
      editable={editable}
      placeholder={placeholder}
      height="100%"
      style={{ height: '100%' }}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLineGutter: true,
        highlightActiveLine: true,
        foldGutter: true,
        dropCursor: true,
        allowMultipleSelections: true,
        indentOnInput: true,
        bracketMatching: true,
        closeBrackets: true,
        autocompletion: false,
        rectangularSelection: true,
        crosshairCursor: false,
        highlightSelectionMatches: true,
        closeBracketsKeymap: true,
        searchKeymap: true,
        foldKeymap: true,
        completionKeymap: false,
        lintKeymap: true,
      }}
    />
  );
}

export default YamlEditor;
