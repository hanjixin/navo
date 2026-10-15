import { useState, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'

const isMac = window.api.platform === 'darwin'

/** "Alt+Shift+Space" → "⌥⇧Space" on macOS, unchanged elsewhere. */
function formatAccelerator(acc: string): string {
  if (!isMac) return acc
  return acc
    .split('+')
    .map((p) => ({ Command: '⌘', CommandOrControl: '⌘', Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧' })[p] ?? p)
    .join('')
}

/** Electron accelerator for a key press, or null while only modifiers are held / no modifier is used. */
function acceleratorOf(e: KeyboardEvent): string | null {
  const mods = [e.metaKey && 'Command', e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean) as string[]
  const code = e.code
  const key = /^Key[A-Z]$/.test(code)
    ? code.slice(3)
    : /^Digit\d$/.test(code)
      ? code.slice(5)
      : /^F\d{1,2}$/.test(code)
        ? code
        : (
            {
              Space: 'Space',
              Enter: 'Return',
              Backquote: '`',
              Slash: '/',
              Period: '.',
              Comma: ',',
              Semicolon: ';',
              Quote: "'",
              BracketLeft: '[',
              BracketRight: ']',
            } as Record<string, string>
          )[code]
  if (!key || !mods.length) return null
  return [...mods, key].join('+')
}

/** Click, then press the new shortcut (Esc cancels). */
export function ShortcutInput({ value, onChange, invalid }: { value: string; onChange: (v: string) => void; invalid?: boolean }) {
  const [recording, setRecording] = useState(false)
  return (
    <button
      type="button"
      onClick={() => setRecording(true)}
      onBlur={() => setRecording(false)}
      onKeyDown={(e) => {
        if (!recording) return
        e.preventDefault()
        if (e.key === 'Escape') return setRecording(false)
        const acc = acceleratorOf(e)
        if (acc) {
          onChange(acc)
          setRecording(false)
        }
      }}
      className={cn(
        'interactive h-8 min-w-28 rounded-md border px-3 font-mono text-xs',
        recording ? 'border-primary text-brand' : invalid ? 'border-danger/50 text-danger' : 'border-border hover:border-input',
      )}
      aria-label="修改快捷键"
    >
      {recording ? '按下新的快捷键…' : value ? formatAccelerator(value) : '未设置'}
    </button>
  )
}
