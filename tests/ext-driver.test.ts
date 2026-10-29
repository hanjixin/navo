import { describe, expect, it, vi } from 'vitest'
import { chooserNotice, DIALOG_SHIM } from '../src/main/browser/dialogs'
import type { Link } from '../src/main/external-browser/bridge'
import { ExtTabs } from '../src/main/external-browser/ext-tabs'
import { NeedExtension, Targets } from '../src/main/external-browser/targets'
import type { PageDriver } from '../src/main/browser/page-driver'
import type { ExtEventName, ExtMethod } from '../src/main/external-browser/protocol'

type Params = Record<string, unknown>
type Cdp = { method: string; params: Params }

/** A stand-in for the extension: answers requests like a browser with tabs 7, 8, 9 would. */
function fakeLink(over: { tabs?: number[]; evaluate?: (p: Params) => unknown } = {}) {
  const calls: { method: ExtMethod; params: Params }[] = []
  const listeners = new Map<ExtEventName, Set<(p: unknown) => void>>()
  let world = 0
  let closed = false
  const link: Link & { cdpCalls(m: string): Params[]; calls: typeof calls; emit(n: ExtEventName, p: unknown): void; close(): void } = {
    browser: 'Google Chrome',
    get closed() {
      return closed
    },
    calls,
    async request<T>(method: ExtMethod, params: Params = {}): Promise<T> {
      if (closed) throw new Error('与浏览器扩展的连接已断开')
      calls.push({ method, params })
      const r = (v: unknown) => v as T
      if (method === 'tabs.create') return r({ tabId: 7, url: params.url ?? 'about:blank', title: '' })
      if (method === 'tabs.list') return r((over.tabs ?? [7, 8, 9]).map((tabId) => ({ tabId, url: `https://t${tabId}.test/`, title: `T${tabId}` })))
      if (method !== 'cdp.send') return r(null)
      const c = params as unknown as Cdp
      if (c.method === 'Page.getFrameTree') return r({ frameTree: { frame: { id: 'F1', url: 'https://a.test/' } } })
      if (c.method === 'Page.createIsolatedWorld') return r({ executionContextId: ++world })
      if (c.method === 'Page.addScriptToEvaluateOnNewDocument') return r({ identifier: 'S1' })
      if (c.method === 'Runtime.evaluate') return r(over.evaluate ? over.evaluate(c.params) : { result: { value: 42 } })
      return r({})
    },
    on<P>(name: ExtEventName, fn: (p: P) => void) {
      let set = listeners.get(name)
      if (!set) listeners.set(name, (set = new Set()))
      set.add(fn as (p: unknown) => void)
      return () => set.delete(fn as (p: unknown) => void)
    },
    cdpCalls: (m) =>
      calls.filter((c) => c.method === 'cdp.send' && (c.params as unknown as Cdp).method === m).map((c) => (c.params as unknown as Cdp).params ?? {}),
    emit: (n, p) => listeners.get(n)?.forEach((fn) => fn(p)),
    close: () => {
      closed = true
    },
  }
  return link
}

describe('ExternalPageDriver', () => {
  it('evaluates in a navo-agent isolated world, created once per document', async () => {
    const link = fakeLink()
    const tabs = new ExtTabs(async () => link)
    const p = await tabs.create('https://a.test')
    expect(p.id).toBe('ext:7')
    expect(p.kind).toBe('external')
    expect(await p.evalIn('1')).toBe(42)
    await p.evalIn('2')
    const worlds = link.cdpCalls('Page.createIsolatedWorld')
    expect(worlds).toHaveLength(1)
    expect(worlds[0]).toMatchObject({ frameId: 'F1', worldName: 'navo-agent' })
    const ev = link.cdpCalls('Runtime.evaluate').at(-1)!
    expect(ev).toMatchObject({ contextId: 1, awaitPromise: true, returnByValue: true })
    expect(ev.expression).toContain('return (2)')
    link.emit('cdp', { tabId: 7, method: 'Page.frameNavigated', params: { frame: { id: 'F1', url: 'https://b.test/' } } })
    await p.evalIn('3')
    expect(link.cdpCalls('Page.createIsolatedWorld')).toHaveLength(2)
    expect(p.url()).toBe('https://b.test/')
  })

  it('turns exceptionDetails into an error', async () => {
    const link = fakeLink({ evaluate: () => ({ exceptionDetails: { exception: { description: 'Error: 元素 e3 已失效' } } }) })
    const p = await new ExtTabs(async () => link).create()
    await expect(p.evalIn('x')).rejects.toThrow('元素 e3 已失效')
  })

  it('reports a closed tab and a cancelled debugging session', async () => {
    const link = fakeLink()
    const tabs = new ExtTabs(async () => link)
    const p = await tabs.create()
    await p.evalIn('1')
    link.emit('tabRemoved', { tabId: 7 })
    await expect(p.evalIn('1')).rejects.toThrow('标签页已被关闭')

    const link2 = fakeLink()
    const q = await new ExtTabs(async () => link2).create()
    await q.evalIn('1')
    link2.emit('detached', { tabId: 7, reason: 'canceled_by_user' })
    await expect(q.evalIn('1')).rejects.toThrow('取消了调试')
  })

  it('reattaches after the extension reconnects', async () => {
    const link1 = fakeLink()
    const link2 = fakeLink()
    let current = link1
    const p = await new ExtTabs(async () => current).create()
    await p.evalIn('1')
    link1.close()
    current = link2
    expect(await p.evalIn('1')).toBe(42)
    expect(link2.calls.map((c) => c.method).slice(0, 1)).toEqual(['debugger.attach'])
    expect(link2.calls[0].params).toEqual({ tabId: 7 })
    expect(link2.cdpCalls('Page.createIsolatedWorld')).toHaveLength(1)
  })

  it('fails after waiting when the extension stays away', async () => {
    const link = fakeLink()
    let current: Link | null = link
    const p = await new ExtTabs(async () => current).create()
    link.close()
    current = null
    await expect(p.evalIn('1')).rejects.toThrow('与浏览器扩展的连接已断开')
  })

  it('takes over dialogs and file choosers', async () => {
    const link = fakeLink()
    const tabs = new ExtTabs(async () => link)
    const p = await tabs.create()
    await p.prepare()
    for (const m of ['Page.enable', 'Runtime.enable']) expect(link.cdpCalls(m)).toHaveLength(1)
    expect(link.cdpCalls('Page.addScriptToEvaluateOnNewDocument')[0]).toEqual({ source: DIALOG_SHIM })
    expect(link.cdpCalls('Page.setInterceptFileChooserDialog')[0]).toEqual({ enabled: true })
    await p.prepare()
    expect(link.cdpCalls('Page.enable')).toHaveLength(1)

    link.emit('cdp', {
      tabId: 7,
      method: 'Runtime.consoleAPICalled',
      params: { args: [{ value: '__navo_dialog__{"type":"alert","message":"hi","answer":null}' }] },
    })
    expect(p.takeNotices()).toEqual(['页面弹出提示框：「hi」，已关闭'])
    link.emit('cdp', { tabId: 7, method: 'Page.fileChooserOpened', params: { backendNodeId: 5, mode: 'selectSingle' } })
    expect(p.chooser()).toEqual({ backendNodeId: 5 })
    expect(p.takeNotices()).toContain(chooserNotice('selectSingle'))
    p.clearChooser()
    expect(p.chooser()).toBeNull()
    link.emit('cdp', { tabId: 7, method: 'Page.downloadWillBegin', params: { suggestedFilename: 'a.pdf', url: 'https://a.test/a.pdf' } })
    expect(p.takeNotices().join('\n')).toContain('a.pdf')
    expect(tabs.downloads()[0].filename).toBe('a.pdf')
    // events of other tabs are not this page's
    link.emit('cdp', { tabId: 8, method: 'Page.fileChooserOpened', params: { backendNodeId: 9, mode: 'selectSingle' } })
    expect(p.chooser()).toBeNull()
  })

  it('answers native dialogs the shim missed by the dialog policy', async () => {
    const link = fakeLink()
    const p = await new ExtTabs(async () => link).create()
    await p.prepare()
    await p.setDialogPolicy({ confirm: true, prompt: null })
    link.emit('cdp', { tabId: 7, method: 'Page.javascriptDialogOpening', params: { type: 'confirm', message: '离开？' } })
    await new Promise((r) => setTimeout(r, 0))
    expect(link.cdpCalls('Page.handleJavaScriptDialog').at(-1)).toEqual({ accept: true })
    expect(p.takeNotices().join('\n')).toContain('离开？')
  })
})

describe('ExtTabs', () => {
  it('lists only tabs the agent opened or the user handed over', async () => {
    const link = fakeLink()
    const tabs = new ExtTabs(async () => link)
    await tabs.create()
    // handing over requires the tab map to know the link: the first request connects it
    link.emit('handover', { tabId: 9, url: 'https://t9.test/', title: 'T9' })
    expect((await tabs.list()).map((t) => t.tabId)).toEqual([7, 9])
    expect((await tabs.list()).find((t) => t.tabId === 7)?.owned).toBe(true)
    expect(() => tabs.driver(8)).toThrow('没有交给 Navo')
    expect(tabs.handed().map((t) => t.tabId)).toEqual([9])
    expect(tabs.driver(9).id).toBe('ext:9')
    link.emit('revoke', { tabId: 9 })
    expect((await tabs.list()).map((t) => t.tabId)).toEqual([7])
  })

  it('a revoked or closed tab forgets its driver', async () => {
    const link = fakeLink()
    const tabs = new ExtTabs(async () => link)
    const p = await tabs.create()
    expect(tabs.driver(7)).toBe(p)
    await tabs.close(7)
    expect(link.calls.at(-1)).toEqual({ method: 'tabs.close', params: { tabId: 7 } })
    expect(() => tabs.driver(7)).toThrow()
  })
})

describe('Targets', () => {
  const builtin = { id: 'builtin:1', kind: 'builtin' } as PageDriver
  function setup(opts: { handed?: number[]; linked?: boolean } = {}) {
    const link = fakeLink()
    const tabs = new ExtTabs(async () => link)
    for (const tabId of opts.handed ?? []) {
      // the tab map follows the link once something used it
      tabs.watch(link)
      link.emit('handover', { tabId, url: `https://t${tabId}.test/`, title: `T${tabId}` })
    }
    const targets = new Targets({ tabs, linked: () => opts.linked ?? true, builtin: () => builtin })
    return { link, tabs, targets }
  }

  it('defaults to the built-in browser', () => {
    const { targets } = setup()
    expect(targets.get('t1')).toBe('builtin')
    expect(targets.page('t1')).toBe(builtin)
  })

  it('uses the most recently handed tab, else opens a new one', async () => {
    vi.useFakeTimers()
    const { targets, link, tabs } = setup()
    tabs.watch(link)
    link.emit('handover', { tabId: 8, url: '', title: '' })
    vi.advanceTimersByTime(10)
    link.emit('handover', { tabId: 9, url: '', title: '' })
    vi.useRealTimers()
    expect((await targets.useMine('t1')).tabId).toBe(9)
    expect(targets.get('t1')).toBe('mine')
    expect(targets.page('t1').id).toBe('ext:9')
    // 9 is t1's: the next conversation takes 8
    expect((await targets.useMine('t2')).tabId).toBe(8)
    expect(link.calls.some((c) => c.method === 'tabs.create')).toBe(false)
    // nothing handed left: a new tab
    expect((await targets.useMine('t3')).tabId).toBe(7)
    expect(link.calls.some((c) => c.method === 'tabs.create')).toBe(true)
  })

  it('keeps the conversation on its tab when switching again', async () => {
    const { targets } = setup()
    const first = await targets.useMine('t1')
    await targets.useBuiltin('t1')
    expect(targets.get('t1')).toBe('builtin')
    expect((await targets.useMine('t1')).tabId).toBe(first.tabId)
  })

  it('asks for the extension when it is not connected', async () => {
    const { targets } = setup({ linked: false })
    await expect(targets.useMine('t1')).rejects.toBeInstanceOf(NeedExtension)
    expect(targets.get('t1')).toBe('builtin')
  })

  it('endRun detaches but keeps the choice', async () => {
    const { targets, link } = setup()
    const d = await targets.useMine('t1')
    await d.evalIn('1')
    await targets.endRun('t1')
    expect(link.calls.at(-1)).toEqual({ method: 'debugger.detach', params: { tabId: 7 } })
    expect(targets.get('t1')).toBe('mine')
  })

  it('a tab gone from the browser falls back to a new one on the next switch', async () => {
    const { targets, link } = setup()
    await targets.useMine('t1')
    link.emit('tabRemoved', { tabId: 7 })
    await targets.useMine('t1')
    expect(link.calls.filter((c) => c.method === 'tabs.create')).toHaveLength(2)
  })
})
