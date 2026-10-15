import { describe, expect, it } from 'vitest'
import { isValidAccelerator } from '../src/shared/accelerator'

describe('isValidAccelerator', () => {
  it('accepts modifiers plus one key', () => {
    for (const a of ['Alt+Space', 'Alt+Shift+Space', 'CommandOrControl+Shift+K', 'Command+1', 'Control+F12', 'Alt+/', 'Shift+Alt+Return'])
      expect(isValidAccelerator(a), a).toBe(true)
  })
  it('rejects a key without modifier, unknown parts and malformed strings', () => {
    for (const a of ['Q', 'Space', 'NotAKey+Q', 'Alt+', 'Alt+Foo', 'Alt+Alt+K', 'Alt+K+J', '', '+K']) expect(isValidAccelerator(a), a).toBe(false)
  })
})
