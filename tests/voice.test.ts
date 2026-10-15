import { describe, expect, it } from 'vitest'
import { fullWidthPunctuation } from '../src/shared/cjk'
import { encodeWav } from '../src/shared/wav'

describe('WAV for speech services', () => {
  it('16-bit mono PCM with a correct header, samples clipped to range', () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 2, -2]), 16000)
    const v = new DataView(wav.buffer)
    const str = (o: number, n: number) => String.fromCharCode(...wav.subarray(o, o + n))
    expect(str(0, 4)).toBe('RIFF')
    expect(str(8, 8)).toBe('WAVEfmt ')
    expect(v.getUint32(4, true)).toBe(36 + 10)
    expect(v.getUint16(20, true)).toBe(1) // PCM
    expect(v.getUint16(22, true)).toBe(1) // mono
    expect(v.getUint32(24, true)).toBe(16000)
    expect(v.getUint32(28, true)).toBe(32000) // bytes per second
    expect(str(36, 4)).toBe('data')
    expect(v.getUint32(40, true)).toBe(10)
    expect([0, 1, 2, 3, 4].map((i) => v.getInt16(44 + i * 2, true))).toEqual([0, 16383, -16383, 32767, -32767])
  })
})

describe('punctuation in Chinese transcripts', () => {
  it('ASCII punctuation next to Chinese becomes full-width; English is left alone', () => {
    expect(fullWidthPunctuation('帮我查一下明天北京的天气,然后发到群里。')).toBe('帮我查一下明天北京的天气，然后发到群里。')
    expect(fullWidthPunctuation('明天下雨吗?')).toBe('明天下雨吗？')
    expect(fullWidthPunctuation('好的.')).toBe('好的。')
    expect(fullWidthPunctuation('Hello, world. Version 1.2')).toBe('Hello, world. Version 1.2')
    expect(fullWidthPunctuation('用 Python, 然后')).toBe('用 Python, 然后')
  })
})
