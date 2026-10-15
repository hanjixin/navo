const MODIFIERS = new Set(['command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl', 'alt', 'option', 'altgr', 'shift', 'super', 'meta'])
const NAMED_KEYS = new Set([
  'space',
  'tab',
  'return',
  'enter',
  'backspace',
  'delete',
  'insert',
  'escape',
  'esc',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'plus',
  'capslock',
  'numlock',
  'scrolllock',
  'printscreen',
])

/**
 * Whether `acc` is a usable global shortcut: one or more modifiers plus exactly one key
 * ("Alt+Space", "CommandOrControl+Shift+K"). Electron accepts some malformed strings silently,
 * so they are checked here first.
 */
export function isValidAccelerator(acc: string): boolean {
  const parts = acc.split('+').map((p) => p.trim())
  if (parts.length < 2 || parts.some((p) => !p)) return false
  const key = parts[parts.length - 1]
  const mods = parts.slice(0, -1).map((m) => m.toLowerCase())
  if (!mods.every((m) => MODIFIERS.has(m)) || new Set(mods).size !== mods.length) return false
  return /^[A-Za-z0-9]$/.test(key) || /^F([1-9]|1\d|2[0-4])$/.test(key) || NAMED_KEYS.has(key.toLowerCase()) || /^[`\-=[\];',./\\]$/.test(key)
}
