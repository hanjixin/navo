import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { Macro } from '../src/shared/types'
const mocks = vi.hoisted(() => ({ eval: vi.fn(), click: vi.fn(), press: vi.fn(), control: vi.fn(), navigate: vi.fn(), wait: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { on: vi.fn() } }))
vi.mock('../src/main/core/db', () => ({ db: vi.fn() }))
vi.mock('../src/main/core/ipc', () => ({ emit: vi.fn() }))
vi.mock('../src/main/core/logger', () => ({ log: { warn: vi.fn() } }))
vi.mock('../src/main/skills/skill-service', () => ({ skills: {} }))
vi.mock('../src/main/browser/page-driver', () => ({ builtinDriver: (wc: unknown) => wc }))
vi.mock('../src/main/browser/browser-service', () => ({
  browser: {
    evalIn: mocks.eval,
    clickRef: mocks.click,
    pressKey: mocks.press,
    setControlled: mocks.control,
    navigate: mocks.navigate,
    waitForLoad: mocks.wait,
  },
}))
import { recorder } from '../src/main/recorder/recorder-service'
import { cancellable, pause } from '../src/main/flows/cancellation'
const wc = {} as WebContents
const macro = (steps: Macro['steps']): Macro => ({
  id: 'macro',
  name: 'Macro',
  description: '',
  startUrl: '',
  params: [],
  steps,
  exposeAsTool: false,
  createdAt: 1,
  updatedAt: 1,
})
beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})
describe('cancellable fixed replay', () => {
  it('interrupts a long wait and never performs the next step', async () => {
    vi.spyOn(recorder, 'get').mockReturnValue(
      macro([
        { id: 'wait', type: 'wait', value: '60000' },
        { id: 'click', type: 'click', selectors: ['button'] },
      ]),
    )
    const controller = new AbortController()
    const work = recorder.run('macro', {}, wc, true, controller.signal)
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()
    expect(await work).toMatchObject({ ok: false, aborted: true })
    expect(mocks.click).not.toHaveBeenCalled()
    expect(mocks.control).toHaveBeenLastCalledWith(wc, false)
  })
  it('checks cancellation after an async lookup, before clicking the returned element', async () => {
    const controller = new AbortController()
    vi.spyOn(recorder, 'get').mockReturnValue(macro([{ id: 'click', type: 'click', selectors: ['button'] }]))
    mocks.eval.mockImplementationOnce(async () => {
      controller.abort()
      return 'ref'
    })
    expect(await recorder.run('macro', {}, wc, true, controller.signal)).toMatchObject({ aborted: true })
    expect(mocks.click).not.toHaveBeenCalled()
  })
  it('does not swallow cancellation in the optional Enter selector lookup', async () => {
    const controller = new AbortController()
    vi.spyOn(recorder, 'get').mockReturnValue(macro([{ id: 'enter', type: 'press', selectors: ['input'], key: 'Enter' }]))
    mocks.eval.mockImplementationOnce(async () => {
      controller.abort()
      throw new Error('lookup cancelled')
    })
    expect(await recorder.run('macro', {}, wc, true, controller.signal)).toMatchObject({ aborted: true })
    expect(mocks.press).not.toHaveBeenCalled()
  })
  it('releases control if cancellation happens while acquiring it', async () => {
    const controller = new AbortController()
    vi.spyOn(recorder, 'get').mockReturnValue(macro([]))
    mocks.control.mockImplementationOnce(async () => {
      controller.abort()
    })
    expect(await recorder.run('macro', {}, wc, true, controller.signal)).toMatchObject({ aborted: true })
    expect(mocks.control).toHaveBeenLastCalledWith(wc, false)
  })
  it('cancels timer and load waits without requiring the underlying load to finish', async () => {
    const controller = new AbortController()
    const timer = pause(60000, controller.signal)
    const load = cancellable(new Promise(() => {}), controller.signal)
    controller.abort(new Error('Stopped'))
    await expect(timer).rejects.toThrow('Stopped')
    await expect(load).rejects.toThrow('Stopped')
  })
})

it('cancels while navigation is still loading and never advances to input', async () => {
  const controller = new AbortController()
  vi.spyOn(recorder, 'get').mockReturnValue(
    macro([
      { id: 'navigate', type: 'navigate', url: 'https://example.org' },
      { id: 'enter', type: 'press', key: 'Enter' },
    ]),
  )
  mocks.navigate.mockImplementationOnce(() => new Promise(() => {}))
  const work = recorder.run('macro', {}, wc, true, controller.signal)
  await Promise.resolve()
  await Promise.resolve()
  controller.abort()
  expect(await work).toMatchObject({ aborted: true })
  expect(mocks.press).not.toHaveBeenCalled()
})
