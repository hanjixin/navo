// Native protocol regression in --fake mode. Safe to run without desktop permissions.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const desktopHelperPath = () => resolve('dist/desktop', process.platform === 'win32' ? `win-${process.arch}/navo-desktop.exe` : 'navo-desktop')

export async function checkDesktopHelper() {
  const executable = desktopHelperPath()
  if (!existsSync(executable)) throw new Error(`Build the desktop helper before running this test: ${executable}`)
  const child = spawn(executable, ['--fake'], { stdio: ['pipe', 'pipe', 'inherit'] })
  const pending = new Map()
  let sequence = 0
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    const message = JSON.parse(line)
    const call = pending.get(message.id)
    if (!call) return
    pending.delete(message.id)
    clearTimeout(call.timeout)
    if (message.ok) call.resolve(message.result)
    else call.reject(new Error(message.error))
  })
  const exited = new Promise((resolve) => {
    child.once('exit', resolve)
    child.once('error', resolve)
  })
  let failed
  const fail = (error) => {
    failed = error
    for (const call of pending.values()) {
      clearTimeout(call.timeout)
      call.reject(error)
    }
    pending.clear()
  }
  child.on('exit', () => fail(new Error('Helper exited before responding')))
  child.on('error', fail)
  child.stdin.on('error', fail)
  function request(cmd, args = {}) {
    if (failed) return Promise.reject(failed)
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`Helper timed out: ${cmd}`))
        child.kill('SIGTERM')
      }, 5000)
      pending.set(id, { resolve, reject, timeout })
      child.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`)
    })
  }
  const bundleId = 'com.apple.TextEdit'
  let expectedWindow
  try {
    await assert.rejects(request('type', { bundleId, expectedWindow, text: 'x' }), /监听|停止/)
    await request('watch_user_input', { enabled: true })
    await request('activate', { bundleId })
    const snapshot = await request('ax_tree', { bundleId })
    expectedWindow = snapshot.window
    assert.ok(expectedWindow?.id)
    const screenshot = await request('screenshot', { bundleId })
    assert.deepEqual(screenshot.window, expectedWindow)
    assert.deepEqual(screenshot.bounds, expectedWindow.bounds)
    assert.deepEqual((await request('window_at', { x: 110, y: 110 })).window, expectedWindow)
    await assert.rejects(request('click', { bundleId }), /窗口/)
    for (const changed of [
      { ...expectedWindow, id: 'other-window' },
      { ...expectedWindow, pid: expectedWindow.pid + 1 },
      { ...expectedWindow, bounds: { ...expectedWindow.bounds, x: expectedWindow.bounds.x + 1 } },
    ])
      await assert.rejects(request('click', { bundleId, expectedWindow: changed }), /窗口/)
    const first = snapshot.nodes[0]
    await request('type', { bundleId, expectedWindow, ref: first.id, text: '你好' })
    const second = (await request('ax_tree', { bundleId })).nodes[0]
    assert.ok(second.value.includes('你好'))
    await assert.rejects(request('click', { bundleId, expectedWindow, ref: first.id }), /引用已失效/)

    const typing = assert.rejects(request('type', { bundleId, expectedWindow, text: 'x'.repeat(10_000) }), /停止/)
    await new Promise((r) => setTimeout(r, 30))
    const queued = assert.rejects(request('key', { bundleId, expectedWindow, combo: 'space' }), /停止/)
    const start = performance.now()
    await request('release')
    await Promise.all([typing, queued])
    assert.ok(performance.now() - start < 1000, 'Release must interrupt long typing within one second')
    await assert.rejects(request('key', { bundleId, expectedWindow, combo: 'space' }), /停止|监听/)
    await request('watch_user_input', { enabled: false })
    await assert.rejects(request('activate', { bundleId }), /停止|监听/)
    await request('watch_user_input', { enabled: true })
    await request('activate', { bundleId })
    await request('key', { bundleId, expectedWindow, combo: 'space' })
    console.log('PASS native helper: Unicode, stale refs, release interrupts long input, queued input canceled, stop lock and explicit recovery')
  } finally {
    await request('release').catch(() => undefined)
    child.stdin.end()
    const timeout = setTimeout(() => child.kill('SIGTERM'), 1000)
    await exited
    clearTimeout(timeout)
    lines.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (['darwin', 'win32'].includes(process.platform)) await checkDesktopHelper()
  else console.log('SKIP desktop helper: macOS and Windows only')
}
