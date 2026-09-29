import { describe, expect, it, vi } from 'vitest'

// memory-service pulls in Electron-bound modules; only the pure date helper is under test here
vi.mock('../src/main/core/db', () => ({ db: () => null, kv: { get: () => null, set: () => undefined } }))
vi.mock('../src/main/core/ipc', () => ({ emit: () => undefined }))
vi.mock('../src/main/core/logger', () => ({ log: { info: () => undefined, warn: () => undefined } }))
vi.mock('../src/main/core/paths', () => ({ paths: {} }))
vi.mock('../src/main/core/settings', () => ({ getSettings: () => ({}) }))
vi.mock('../src/main/models/registry', () => ({ createChatModel: () => null }))

const { isSmallTalk, localDay } = await import('../src/main/memory/memory-service')

describe('localDay', () => {
  it('uses the local calendar day and handles month / year boundaries', () => {
    const d = new Date(2026, 0, 1, 0, 30) // just after local midnight
    expect(localDay(0, d)).toBe('2026-01-01')
    expect(localDay(-1, d)).toBe('2025-12-31')
    expect(localDay(-1, new Date(2026, 2, 1, 23, 59))).toBe('2026-02-28')
  })
})

describe('isSmallTalk', () => {
  it('skips pure pleasantries', () => {
    for (const t of ['谢谢', '谢谢你！', '好的', 'ok', 'Thanks!', '收到。', '嗯嗯', '你好', '👍']) expect(isSmallTalk(t)).toBe(true)
  })
  it('keeps anything with content, however short', () => {
    for (const t of ['我叫小韩', '好的，用表格', '谢谢，另外记住我在上海', '以后用英文', 'ok 帮我订票']) expect(isSmallTalk(t)).toBe(false)
  })
})
