import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeWatchdog } from '../src/main/agent-runtime/watchdog'

describe('runtime watchdog', () => {
  afterEach(() => vi.useRealTimers())
  it('times out when no first response arrives', () => {
    vi.useFakeTimers()
    const timeout = vi.fn()
    const watchdog = new RuntimeWatchdog({ firstTokenMs: 10, idleMs: 20, onTimeout: timeout })
    watchdog.start()
    vi.advanceTimersByTime(11)
    expect(timeout).toHaveBeenCalledWith('Runtime did not produce a first response before the timeout')
  })
  it('pauses during approval and resumes idle monitoring afterwards', () => {
    vi.useFakeTimers()
    const timeout = vi.fn()
    const watchdog = new RuntimeWatchdog({ firstTokenMs: 10, idleMs: 20, onTimeout: timeout })
    watchdog.start()
    watchdog.pause()
    vi.advanceTimersByTime(100)
    expect(timeout).not.toHaveBeenCalled()
    watchdog.resume()
    vi.advanceTimersByTime(21)
    expect(timeout).toHaveBeenCalledWith('Runtime stopped producing responses before the idle timeout')
  })
})
