import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { createContext, runInContext, type Context } from 'node:vm'
import type { WebContents } from 'electron'

const state = vi.hoisted(() => ({ database: null as unknown as DatabaseSync, root: '', control: null as Promise<void> | null }))
vi.mock('electron', () => ({ dialog: {} }))
vi.mock('../src/main/core/db', () => ({ db: () => state.database }))
vi.mock('../src/main/core/logger', () => ({ log: { info: vi.fn(), warn: vi.fn() } }))
vi.mock('../src/main/core/paths', () => ({
  paths: {
    get plugins() {
      return state.root
    },
  },
}))
vi.mock('../src/main/browser/browser-service', () => ({ browser: { allTabs: () => [], setControlled: vi.fn(() => state.control ?? Promise.resolve()) } }))
import { PluginService } from '../src/main/plugins/plugin-service'
import { browser } from '../src/main/browser/browser-service'

class Page extends EventEmitter {
  url = 'https://example.com/page'
  destroyed = false
  worlds = new Map<number, Context>()
  readyGate: Promise<void> | null = null
  getURL() {
    return this.url
  }
  isDestroyed() {
    return this.destroyed
  }
  executeJavaScriptInIsolatedWorld = vi.fn(async (world: number, scripts: { code: string }[]) => {
    const code = scripts[0].code
    if (this.readyGate && code.startsWith('window.__agentPlugins?.')) await this.readyGate
    let context = this.worlds.get(world)
    if (!context) {
      context = createContext({ window: {}, console, setTimeout, document: { querySelector: () => null } })
      this.worlds.set(world, context)
    }
    return runInContext(code, context)
  })
}
let service: PluginService
let page: Page
const wc = () => page as unknown as WebContents
const manifest = {
  id: 'test',
  name: 'Test',
  version: '1',
  matches: ['https://example.com/*'],
  contentScript: 'content.js',
  actions: [{ name: 'act', description: 'Test action', parameters: { type: 'object', properties: {} } }],
}
beforeEach(() => {
  state.database = new DatabaseSync(':memory:')
  state.database.exec('CREATE TABLE plugin_state(id TEXT PRIMARY KEY,enabled INTEGER NOT NULL)')
  state.root = mkdtempSync(join(tmpdir(), 'navo-plugin-guard-'))
  mkdirSync(join(state.root, 'test'))
  writeFileSync(join(state.root, 'test', 'manifest.json'), JSON.stringify(manifest))
  writeFileSync(join(state.root, 'test', 'content.js'), "agentPlugin.register('act', () => 'original')")
  state.control = null
  service = new PluginService()
  page = new Page()
  vi.clearAllMocks()
})
afterEach(() => {
  state.database.close()
  rmSync(state.root, { recursive: true, force: true })
})

describe('plugin runtime guards', () => {
  it('rejects a captured tool after disabling before acquiring browser control', async () => {
    const [tool] = service.tools(wc)
    service.setEnabled('test', false)
    await expect(tool.invoke({})).rejects.toThrow()
    expect(browser.setControlled).not.toHaveBeenCalled()
    expect(page.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
  })
  it('invalidates old tools across disable and re-enable while permitting fresh tools', async () => {
    const [old] = service.tools(wc)
    service.setEnabled('test', false)
    service.setEnabled('test', true)
    await expect(old.invoke({})).rejects.toThrow()
    const [fresh] = service.tools(wc)
    expect(await fresh.invoke({})).toBe('original')
  })
  it('stops before dispatch when disabled while waiting for a readiness result', async () => {
    let release!: () => void
    page.readyGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = service.runAction('test', 'act', {}, wc())
    service.setEnabled('test', false)
    release()
    await expect(pending).rejects.toThrow()
    expect(page.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1)
  })
  it('does not let captured tools execute updated code, and replaces stale injected generations', async () => {
    const [old] = service.tools(wc)
    expect(await service.runAction('test', 'act', {}, wc())).toBe('original')
    service.writeFile('test', 'content.js', "agentPlugin.register('act', () => 'updated')")
    await expect(old.invoke({})).rejects.toThrow()
    expect(await service.runAction('test', 'act', {}, wc())).toBe('updated')
  })
  it('rejects a navigation during browser-control acquisition even when the URL is unchanged', async () => {
    let release!: () => void
    state.control = new Promise<void>((resolve) => {
      release = resolve
    })
    const [tool] = service.tools(wc)
    const pending = tool.invoke({})
    await new Promise<void>((resolve) => setImmediate(resolve))
    page.emit('did-navigate')
    release()
    await expect(pending).rejects.toThrow()
    expect(page.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
  })
  it('rejects removed actions and mismatched pages before executing any page code', async () => {
    await expect(service.runAction('test', 'removed', {}, wc())).rejects.toThrow()
    page.url = 'https://elsewhere.test/'
    await expect(service.runAction('test', 'act', {}, wc())).rejects.toThrow()
    expect(page.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
  })
})
