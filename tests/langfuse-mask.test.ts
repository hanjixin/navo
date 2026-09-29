import { describe, expect, it } from 'vitest'
import { maskImages } from '../src/main/agent-host/langfuse'

describe('maskImages', () => {
  const img = `data:image/jpeg;base64,${'A'.repeat(500)}`
  it('replaces embedded screenshots anywhere in trace payloads', () => {
    const out = maskImages({
      messages: [
        {
          content: [
            { type: 'text', text: 'hi' },
            { type: 'image_url', image_url: { url: img } },
          ],
        },
      ],
      raw: `before ${img} after`,
    })
    expect(JSON.stringify(out)).not.toContain('AAAAAAAA')
    expect(out).toMatchObject({ raw: 'before [截图已省略] after' })
  })
  it('leaves normal text and short data URLs alone', () => {
    expect(maskImages('data:image/png;base64,iVBOR')).toBe('data:image/png;base64,iVBOR')
    expect(maskImages({ a: 1, b: [true, null] })).toEqual({ a: 1, b: [true, null] })
  })
})
