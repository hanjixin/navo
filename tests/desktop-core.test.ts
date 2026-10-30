import { describe, expect, it } from 'vitest'
import { DesktopSnapshot, screenshotPoint, type AXTree, type Screenshot } from '../src/main/desktop/snapshot'
import { DesktopConsent } from '../src/main/desktop/consent'
import type { DesktopConsentRequest } from '../src/shared/types'

const app = { name: 'Notes', bundleId: 'com.apple.Notes', pid: 123 }
const tree: AXTree = {
  app,
  nodes: [{ id: 'native-1', role: 'AXButton', title: 'Save', enabled: true, depth: 0, frame: { x: 1, y: 2, width: 30, height: 20 } }],
}
const reference = (text: string) => text.match(/\[(d\d+)\]/)![1]

describe('desktop snapshots', () => {
  it('expires references after capture, app switch and clear, without ever recycling them', () => {
    const snapshot = new DesktopSnapshot()
    const first = reference(snapshot.update(tree))
    expect(snapshot.get(first)).toMatchObject({ id: 'native-1', bundleId: app.bundleId })
    const second = reference(snapshot.diff(tree))
    expect(second).not.toBe(first)
    expect(() => snapshot.get(first)).toThrow('已失效')
    const third = reference(snapshot.update({ ...tree, app: { ...app, bundleId: 'other' } }))
    expect(() => snapshot.get(second)).toThrow('已失效')
    expect(snapshot.get(third).bundleId).toBe('other')
    snapshot.clear()
    expect(() => snapshot.get(third)).toThrow('已失效')
    expect(reference(snapshot.update(tree))).not.toBe(third)
  })

  it('honors strict budgets and exposes only references actually printed', () => {
    const snapshot = new DesktopSnapshot()
    const previous = reference(snapshot.update(tree))
    expect(snapshot.update(tree, 0)).toBe('')
    expect(() => snapshot.get(previous)).toThrow()
    const large = { ...tree, nodes: Array.from({ length: 100 }, (_, i) => ({ ...tree.nodes[0], id: String(i), title: 'x'.repeat(i * 10) })) }
    const result = snapshot.update(large, 180)
    expect(result.length).toBeLessThanOrEqual(180)
    for (const match of result.matchAll(/\[(d\d+)\]/g)) expect(snapshot.get(match[1]).bundleId).toBe(app.bundleId)
    expect(snapshot.diff(large, 40).length).toBeLessThanOrEqual(40)
    expect(() => snapshot.update(tree, Infinity)).toThrow()
  })

  it('maps retina pixels into desktop points including negative monitor origins', () => {
    const image: Screenshot = { data: '', width: 2000, height: 1000, bounds: { x: -1000, y: 50, width: 1000, height: 500 } }
    expect(screenshotPoint(image, 1000, 500)).toEqual({ x: -500, y: 300 })
    for (const [x, y] of [
      [-1, 0],
      [2000, 0],
      [0, 1000],
      [NaN, 0],
      [0, Infinity],
    ])
      expect(() => screenshotPoint(image, x, y)).toThrow()
    expect(() => screenshotPoint({ ...image, width: 0 }, 0, 0)).toThrow()
  })

  it('retains the focused composer after a long chat history and labels an empty draft', () => {
    const snapshot = new DesktopSnapshot()
    const history = Array.from({ length: 200 }, (_, i) => ({
      id: `message-${i}`,
      role: 'AXStaticText',
      value: 'Message content '.repeat(20),
      enabled: true,
      depth: 3,
    }))
    const result = snapshot.update({
      app,
      nodes: [
        ...history,
        { id: 'composer', role: 'AXTextArea', value: '', placeholder: 'Message', identifier: 'prompt-textarea', focused: true, enabled: true, depth: 3 },
      ],
    })
    expect(result.length).toBeLessThanOrEqual(12_000)
    expect(result).toContain('AXTextArea value="" placeholder="Message" identifier="prompt-textarea" (focused)')
    const composer = result.split('\n').find((line) => line.includes('AXTextArea'))!
    expect(snapshot.get(reference(composer)).id).toBe('composer')
  })
})

function approvals() {
  const published: (DesktopConsentRequest | null)[] = []
  const blocked: string[] = []
  const consent = new DesktopConsent({ blocked: () => blocked, publish: (request) => published.push(request) })
  const current = () => published.at(-1)!
  return { consent, published, blocked, current }
}

describe('desktop consent', () => {
  it('queues prompts, scopes session grants to a conversation and rechecks the blacklist', async () => {
    const { consent, published, current, blocked } = approvals()
    const first = consent.request('one', app)
    const same = consent.request('one', app)
    const other = consent.request('two', app)
    expect(published).toHaveLength(1)
    consent.resolve(current().id, 'session')
    await Promise.all([first, same])
    expect(current().threadId).toBe('two')
    consent.resolve(current().id, 'once')
    await other
    await consent.request('one', app)
    blocked.push(app.bundleId.toUpperCase())
    await expect(consent.request('one', app)).rejects.toThrow('禁止')
  })

  it('once grants do not persist; stale decisions cannot approve another request', async () => {
    const { consent, current } = approvals()
    const one = consent.request('one', app)
    const old = current().id
    consent.resolve(old, 'once')
    await one
    const two = consent.request('one', app)
    const rejected = expect(two).rejects.toThrow('拒绝')
    expect(current().id).not.toBe(old)
    consent.resolve(old, 'session')
    consent.resolve(current().id, 'deny')
    await rejected
  })

  it('cancels active and queued requests for one thread and advances another', async () => {
    const { consent, current } = approvals()
    const a = consent.request('one', app)
    const b = consent.request('one', app)
    const c = consent.request('two', app)
    const cancelled = [expect(a).rejects.toThrow('取消'), expect(b).rejects.toThrow('取消')]
    consent.cancel('one')
    await Promise.all(cancelled)
    expect(current().threadId).toBe('two')
    consent.resolve(current().id, 'once')
    await c
  })

  it('rechecks blocks while waiting for approval and clears session grants on forget', async () => {
    const { consent, current, blocked } = approvals()
    const pending = consent.request('one', app)
    const denied = expect(pending).rejects.toThrow('拒绝')
    blocked.push(app.bundleId)
    consent.resolve(current().id, 'session')
    await denied
    blocked.length = 0
    const granted = consent.request('one', app)
    consent.resolve(current().id, 'session')
    await granted
    consent.forget('one')
    const again = consent.request('one', app)
    const cancelled = expect(again).rejects.toThrow('取消')
    consent.cancel()
    await cancelled
    expect(current()).toBeNull()
  })
})
