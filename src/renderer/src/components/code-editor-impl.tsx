import Editor, { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker?worker'
import tsWorker from 'monaco-editor/language/typescript/ts.worker?worker'
import { useTheme } from '@/hooks/use-theme'

// Bundle monaco locally — the CSP forbids loading it from a CDN and the app must work offline.
self.MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === 'json') return new jsonWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  },
}
loader.config({ monaco })

monaco.editor.defineTheme('ab-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#ffffff',
    'editorLineNumber.foreground': '#98a2b3',
    'editor.lineHighlightBackground': '#f6f7f9',
    'editorGutter.background': '#ffffff',
  },
})
monaco.editor.defineTheme('ab-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#111a2b',
    'editorLineNumber.foreground': '#5f6b80',
    'editor.lineHighlightBackground': '#151f31',
    'editorGutter.background': '#111a2b',
  },
})

export default function CodeEditorImpl({
  value,
  onChange,
  language,
  readOnly,
  onSave,
}: {
  value: string
  onChange?: (v: string) => void
  language: string
  readOnly?: boolean
  onSave?: () => void
}) {
  const theme = useTheme()
  return (
    <Editor
      value={value}
      language={language}
      theme={theme === 'dark' ? 'ab-dark' : 'ab-light'}
      onChange={(v) => onChange?.(v ?? '')}
      onMount={(editor) => {
        if (onSave) editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, onSave)
      }}
      options={{
        readOnly,
        minimap: { enabled: false },
        fontFamily: "'JetBrains Mono Variable', ui-monospace, monospace",
        fontSize: 12.5,
        lineHeight: 20,
        tabSize: 2,
        wordWrap: 'on',
        scrollBeyondLastLine: false,
        padding: { top: 12, bottom: 12 },
        renderLineHighlight: 'line',
        overviewRulerBorder: false,
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
      }}
      loading={<div className="skeleton h-full w-full rounded-none" />}
    />
  )
}
