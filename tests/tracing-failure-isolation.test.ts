import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ settings: {} as Record<string, unknown>, fail: new Set<string>(), keys: new Map<string, string>() }))
vi.mock('electron', () => ({ app: { isPackaged: false }, nativeTheme: {} }))
vi.mock('../src/main/core/db', () => ({
  kv: {
    get: (_key: string, fallback: unknown) => state.settings ?? fallback,
    set: (_key: string, value: Record<string, unknown>) => {
      state.settings = value
    },
  },
}))
vi.mock('../src/main/core/ipc', () => ({ emit: vi.fn() }))
vi.mock('../src/main/core/secrets', () => ({
  secrets: {
    get: vi.fn((key: string) => {
      if (state.fail.has(key)) throw new Error('SENSITIVE decrypted failure text')
      return state.keys.get(key) ?? null
    }),
    has: (key: string) => state.keys.has(key),
    set: vi.fn((key: string, value: string) => {
      state.keys.set(key, value)
      state.fail.delete(key)
    }),
    delete: vi.fn((key: string) => state.keys.delete(key)),
  },
}))
import { applyTracingEnv, getIntegrationStatus, langfuseConfig, setSettings, testLangfuse } from '../src/main/core/settings'
import { secrets } from '../src/main/core/secrets'
const names = [
  'LANGSMITH_TRACING',
  'LANGSMITH_API_KEY',
  'LANGSMITH_PROJECT',
  'LANGCHAIN_TRACING_V2',
  'LANGCHAIN_API_KEY',
  'LANGCHAIN_PROJECT',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_HOST',
  'LANGFUSE_BASE_URL',
]
let original: Record<string, string | undefined>
beforeEach(() => {
  original = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  state.settings = {}
  state.keys = new Map([
    ['langsmith', 'secret-smith'],
    ['langfuse.secret', 'secret-fuse'],
  ])
  state.fail = new Set()
  vi.clearAllMocks()
})
afterEach(() => {
  for (const name of names) {
    if (original[name] === undefined) delete process.env[name]
    else process.env[name] = original[name]
  }
})

describe('optional tracing failure isolation', () => {
  it('does not decrypt disabled integration keys and clears stale inherited environment', () => {
    for (const name of names) process.env[name] = 'old-secret'
    state.fail = new Set(state.keys.keys())
    expect(() => applyTracingEnv()).not.toThrow()
    expect(langfuseConfig()).toBeUndefined()
    expect(secrets.get).not.toHaveBeenCalled()
    expect(process.env.LANGSMITH_TRACING).toBe('false')
    expect(process.env.LANGCHAIN_TRACING_V2).toBe('false')
    expect(process.env.LANGSMITH_API_KEY).toBeUndefined()
    expect(process.env.LANGFUSE_SECRET_KEY).toBeUndefined()
    expect(getIntegrationStatus()).toEqual({ langsmith: { state: 'disabled' }, langfuse: { state: 'disabled' } })
  })
  it('isolates corrupt LangSmith credentials and leaves valid Langfuse usable', () => {
    state.settings = { devMode: true, langfuse: { enabled: true, publicKey: 'public' } }
    state.fail.add('langsmith')
    expect(() => applyTracingEnv()).not.toThrow()
    expect(process.env.LANGSMITH_API_KEY).toBeUndefined()
    expect(langfuseConfig()).toMatchObject({ publicKey: 'public', secretKey: 'secret-fuse' })
    expect(getIntegrationStatus().langsmith.state).toBe('error')
    expect(JSON.stringify(getIntegrationStatus())).not.toContain('SENSITIVE')
    expect(secrets.delete).not.toHaveBeenCalled()
    expect(secrets.set).not.toHaveBeenCalled()
  })
  it('isolates corrupt Langfuse credentials and supports reconfiguration without deleting the old ciphertext', async () => {
    state.settings = { devMode: true, langfuse: { enabled: true, publicKey: 'public' } }
    state.fail.add('langfuse.secret')
    expect(() => applyTracingEnv()).not.toThrow()
    expect(process.env.LANGSMITH_API_KEY).toBe('secret-smith')
    expect(langfuseConfig()).toBeUndefined()
    expect(getIntegrationStatus().langfuse.state).toBe('error')
    expect(await testLangfuse()).toMatchObject({ ok: false })
    expect(secrets.delete).not.toHaveBeenCalled()
    setSettings({ langfuseSecretKey: 'replacement' })
    expect(langfuseConfig()).toMatchObject({ secretKey: 'replacement' })
    expect(getIntegrationStatus().langfuse.state).toBe('ready')
  })
  it('reading diagnostic status never decrypts credentials or returns them', () => {
    state.settings = { devMode: true, langfuse: { enabled: true, publicKey: 'public' } }
    applyTracingEnv()
    vi.mocked(secrets.get).mockClear()
    expect(JSON.stringify(getIntegrationStatus())).not.toContain('secret')
    expect(secrets.get).not.toHaveBeenCalled()
  })
})
