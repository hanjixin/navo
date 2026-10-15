import { describe, expect, it } from 'vitest'
import {
  actionCount,
  applyParams,
  describeStep,
  parseFlowMeta,
  soundsRepeated,
  splice,
  traceToSteps,
  typedValues,
  fallbackParams,
} from '../src/main/flows/flows-core'
import type { TraceStep } from '../src/main/flows/trace'

let t = 1000
const step = (s: Omit<TraceStep, 'at' | 'url'> & { url?: string }): TraceStep => ({ url: 'http://erp.local/', at: (t += 1000), ...s })

const TRACE: TraceStep[] = [
  step({ type: 'navigate', url: 'http://erp.local/login' }),
  step({ type: 'type', selectors: ['#user'], label: '用户名', value: 'admin' }),
  step({ type: 'type', selectors: ['#pwd'], label: '密码', value: 'hunter2', secret: true }),
  step({ type: 'click', selectors: ['button[type=submit]'], label: '登录' }),
  step({ type: 'navigate', url: 'http://erp.local/orders?q=A-1001' }),
  step({ type: 'type', selectors: ['#order'], label: '单号', value: 'A-10' }),
  step({ type: 'type', selectors: ['#order'], label: '单号', value: 'A-1001' }),
  step({ type: 'press', key: 'Enter', selectors: ['#order'] }),
  step({ type: 'click', selectors: [], label: '无法定位的元素' }),
  step({ type: 'select', selectors: ['select[name=status]'], label: '状态', value: '已发货' }),
]

describe('traceToSteps', () => {
  const flow = traceToSteps(TRACE)
  it('the first page is the start; later navigations the agent made are kept', () => {
    expect(flow.startUrl).toBe('http://erp.local/login')
    expect(flow.steps.filter((s) => s.type === 'navigate').map((s) => s.url)).toEqual(['http://erp.local/orders?q=A-1001'])
  })
  it('typing into the same field collapses to the final value; passwords become a parameter', () => {
    expect(flow.steps.filter((s) => s.type === 'type').map((s) => s.value)).toEqual(['admin', '{{password}}', 'A-1001'])
  })
  it('steps without anything to find the element by are dropped', () => {
    expect(flow.steps.some((s) => s.label === '无法定位的元素')).toBe(false)
    expect(actionCount(flow.steps)).toBe(6)
  })
  it('a repair keeps its first navigation as a step', () => {
    const r = traceToSteps([step({ type: 'navigate', url: 'http://erp.local/v2' }), step({ type: 'click', selectors: ['#go'] })], { keepStartUrl: true })
    expect(r.startUrl).toBeUndefined()
    expect(r.steps.map((s) => s.type)).toEqual(['navigate', 'click'])
  })
})

describe('parameters', () => {
  const flow = traceToSteps(TRACE)
  it('candidates are what was typed or chosen (never passwords)', () => {
    expect(typedValues(flow.steps)).toEqual(['admin', 'A-1001', '已发货'])
  })
  it('applies parameters to values and inside URLs', () => {
    const p = applyParams(flow, [{ name: 'order_no', value: 'A-1001', default: 'A-1001' }])
    expect(p.steps.find((s) => s.label === '单号')?.value).toBe('{{order_no}}')
    expect(p.steps.find((s) => s.type === 'navigate')?.url).toBe('http://erp.local/orders?q={{order_no}}')
    const enc = applyParams({ startUrl: 'http://s.local/?q=%E8%93%9D%E7%89%99', steps: [] }, [{ name: 'kw', value: '蓝牙' }])
    expect(enc.startUrl).toBe('http://s.local/?q={{kw}}')
  })
  it('the model may only parameterise values that were really typed; names are made safe', () => {
    const meta = parseFlowMeta(
      '```json\n{"name":"查询订单状态","description":"按单号查订单","params":[{"name":"Order No","description":"订单号","value":"A-1001"},{"name":"made_up","value":"Z-9"}]}\n```',
      flow.steps,
      'fallback',
    )
    expect(meta.name).toBe('查询订单状态')
    expect(meta.params).toEqual([{ name: 'order_no', description: '订单号', default: 'A-1001', value: 'A-1001' }])
    expect(parseFlowMeta('garbage', flow.steps, '对话标题').name).toBe('对话标题')
  })
})

describe('repair splice', () => {
  it('keeps the steps before the failure and appends what the agent did', () => {
    const steps = traceToSteps(TRACE).steps
    const repair = traceToSteps([step({ type: 'click', selectors: ['#new-search'] })], { keepStartUrl: true }).steps
    const out = splice(steps, 3, repair)
    expect(out.slice(0, 3)).toEqual(steps.slice(0, 3))
    expect(out[3].selectors).toEqual(['#new-search'])
    expect(out).toHaveLength(4)
  })
})

describe('misc', () => {
  it('describes steps for people', () => {
    expect(describeStep({ id: 'a', type: 'type', label: '单号', value: '{{order_no}}' })).toBe('在 「单号」 输入 {{order_no}}')
  })
  it('recognises tasks that sound recurring', () => {
    expect(soundsRepeated('以后每天帮我查一下这个单号的状态')).toBe(true)
    expect(soundsRepeated('帮我查一下这个单号的状态')).toBe(false)
  })
})

describe('generic selectors', () => {
  it('drops bare tags, which would match the wrong element on the next page', () => {
    const r = traceToSteps(
      [step({ type: 'click', selectors: ['role=button[name="导出"]', 'button'], label: '导出' }), step({ type: 'click', selectors: ['div'] })],
      { keepStartUrl: true },
    )
    expect(r.steps).toHaveLength(1)
    expect(r.steps[0].selectors).toEqual(['role=button[name="导出"]'])
  })
})

describe('fallback parameters', () => {
  it('values the user gave in the request become parameters when the model proposes none', () => {
    const steps = traceToSteps([
      step({ type: 'navigate', url: 'http://erp.local/' }),
      step({ type: 'type', selectors: ['#user'], label: '用户名', value: 'admin' }),
      step({ type: 'type', selectors: ['#order'], label: '单号', value: 'A-1001' }),
      step({ type: 'click', selectors: ['#q'], label: '查询' }),
    ]).steps
    const params = fallbackParams('查询订单 A-1001 并导出', steps)
    expect(params).toEqual([{ name: 'value_1', description: '本次输入的「A-1001」', default: 'A-1001', value: 'A-1001' }])
    expect(applyParams({ steps }, params).steps.find((s) => s.label === '单号')?.value).toBe('{{value_1}}')
  })
})
