import { describe, expect, it } from 'vitest'
import { matchPattern, validateManifest } from '../src/main/plugins/manifest'
import { appendEvent, fillTemplate, placeholders, type RawEvent } from '../src/main/recorder/steps'
import type { MacroStep } from '../src/shared/types'

describe('matchPattern', () => {
  it('matches subdomains and paths', () => {
    expect(matchPattern('https://*.taobao.com/*', 'https://s.taobao.com/search?q=1')).toBe(true)
    expect(matchPattern('https://*.taobao.com/*', 'https://taobao.com/')).toBe(true)
    expect(matchPattern('https://*.taobao.com/*', 'https://evil-taobao.com/')).toBe(false)
    expect(matchPattern('https://news.ycombinator.com/*', 'http://news.ycombinator.com/')).toBe(false)
    expect(matchPattern('*://example.com/item*', 'http://example.com/item?id=3')).toBe(true)
    expect(matchPattern('*://example.com/item*', 'https://example.com/other')).toBe(false)
    expect(matchPattern('<all_urls>', 'https://a.b/')).toBe(true)
    expect(matchPattern('<all_urls>', 'data:text/html,x')).toBe(false)
  })
})

describe('validateManifest', () => {
  it('applies defaults and rejects bad ids', () => {
    const m = validateManifest({ id: 'demo', name: 'Demo', matches: ['https://x.com/*'] })
    expect(m.contentScript).toBe('content.js')
    expect(m.actions).toEqual([])
    expect(() => validateManifest({ id: 'Bad Id', name: 'x', matches: ['*'] })).toThrow()
    expect(() => validateManifest({ id: 'ok', name: 'x', matches: [], actions: [] })).toThrow()
  })
})

describe('recorder steps', () => {
  const ev = (e: Partial<RawEvent>): RawEvent => ({ type: 'click', t: 1000, selectors: ['#a'], ...e }) as RawEvent

  it('collapses consecutive typing into one step', () => {
    let steps: MacroStep[] = []
    steps = appendEvent(steps, ev({ type: 'type', value: 'h', selectors: ['#q'] }), 0)
    steps = appendEvent(steps, ev({ type: 'type', value: 'hi', selectors: ['#q'] }), 0)
    expect(steps).toHaveLength(1)
    expect(steps[0].value).toBe('hi')
  })

  it('masks passwords as a parameter', () => {
    const steps = appendEvent([], ev({ type: 'type', value: 'secret', secret: true }), 0)
    expect(steps[0].value).toBe('{{password}}')
  })

  it('drops navigations caused by a preceding action', () => {
    let steps = appendEvent([], ev({ type: 'click', t: 1000 }), 0)
    steps = appendEvent(steps, ev({ type: 'navigate', url: 'https://x', t: 1500 }), 1000)
    expect(steps).toHaveLength(1)
    steps = appendEvent(steps, ev({ type: 'navigate', url: 'https://y', t: 9000 }), 1000)
    expect(steps.at(-1)).toMatchObject({ type: 'navigate', url: 'https://y' })
  })

  it('fills and lists placeholders', () => {
    expect(fillTemplate('hi {{ name }}!', { name: 'Ada' })).toBe('hi Ada!')
    expect(fillTemplate('{{missing}}', {})).toBe('')
    expect(
      placeholders([
        { id: '1', type: 'type', value: '{{a}} {{b}}' },
        { id: '2', type: 'navigate', url: 'https://x/{{a}}' },
      ]),
    ).toEqual(['a', 'b'])
  })
})
