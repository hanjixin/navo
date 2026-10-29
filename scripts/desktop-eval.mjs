// Manual native desktop smoke. Never runs as part of the test suite.
// node scripts/desktop-eval.mjs --run [--stop-test]
// Requires macOS 14+, built helper, Accessibility + Screen Recording permissions.
// Creates a NEW unsaved TextEdit document. Leaves it open for inspection; never saves or overwrites files.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import assert from 'node:assert/strict'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const binary = resolve(root, 'dist/desktop/navo-desktop')
if (!process.argv.includes('--run')) {
  console.log(
    'Manual evaluation: node scripts/desktop-eval.mjs --run [--stop-test]\nCreates a new unsaved TextEdit document and writes a screenshot to dist/desktop/eval.jpg.\nGrant Accessibility and Screen Recording permissions to the helper/launching app first.\n--stop-test asks you to press Escape during long typing to verify immediate interruption.',
  )
  process.exit(0)
}
if (process.platform !== 'darwin') throw new Error('Desktop evaluation requires macOS 14 or newer.')
if (!existsSync(binary)) throw new Error('Build first: node scripts/build-desktop-helper.mjs')
const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] })
const pending = new Map()
let seq = 0
let inputEvent
const lines = createInterface({ input: child.stdout })
lines.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.event === 'user_input') {
    inputEvent = message
    console.log(`User intervention: ${message.reason}`)
    return
  }
  const call = pending.get(message.id)
  if (!call) return
  pending.delete(message.id)
  clearTimeout(call.timeout)
  if (message.ok) call.resolve(message.result)
  else call.reject(new Error(message.error))
})
child.on('exit', (code) => {
  for (const call of pending.values()) {
    clearTimeout(call.timeout)
    call.reject(new Error(`Helper exited (${code})`))
  }
  pending.clear()
})
function request(cmd, args = {}, timeoutMs = 15_000) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Timed out: ${cmd}`))
      child.kill('SIGTERM')
    }, timeoutMs)
    pending.set(id, { resolve, reject, timeout })
    child.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`)
  })
}
const bundleId = 'com.apple.TextEdit'
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
try {
  const permissions = await request('permissions')
  assert.ok(
    permissions.accessibility && permissions.screenRecording,
    'Both Accessibility and Screen Recording must be granted before the manual evaluation; no permission prompt is triggered by this script.',
  )
  assert.equal((await request('resolve', { app: bundleId })).bundleId, bundleId)
  console.log('Starting in 3 seconds. Keep hands off the mouse until the test ends; Escape stops control.')
  await pause(3000)
  await request('watch_user_input', { enabled: true })
  await request('activate', { bundleId })
  await assert.rejects(request('key', { bundleId: 'com.apple.finder', combo: 'space' }), /前台|未运行/)
  await request('key', { bundleId, combo: 'cmd+n' })
  await pause(700)
  const tree = await request('ax_tree', { bundleId })
  const editor = tree.nodes.find((node) => node.role === 'AXTextArea' && node.enabled)
  assert.ok(editor, 'TextEdit must show a new editable document; close any initial file picker then rerun.')
  const marker = 'Navo desktop smoke — 你好，桌面！'
  await request('type', { bundleId, ref: editor.id, text: marker })
  await pause(300)
  const updated = await request('ax_tree', { bundleId })
  assert.ok(
    updated.nodes.some((node) => typeof node.value === 'string' && node.value.includes(marker)),
    'Unicode text must appear in the AX tree.',
  )
  await assert.rejects(request('click', { bundleId, ref: editor.id }), /引用已失效/)
  const shot = await request('screenshot', { bundleId })
  assert.ok(shot.width > 0 && shot.height > 0 && shot.bounds.width > 0)
  const jpeg = Buffer.from(shot.data, 'base64')
  assert.equal(jpeg.subarray(0, 2).toString('hex'), 'ffd8')
  mkdirSync(resolve(root, 'dist/desktop'), { recursive: true })
  writeFileSync(resolve(root, 'dist/desktop/eval.jpg'), jpeg)
  const center = { x: shot.bounds.x + shot.bounds.width / 2, y: shot.bounds.y + shot.bounds.height / 2 }
  assert.equal((await request('window_at', center))?.bundleId, bundleId, 'Screenshot bounds must map to the target window in Quartz screen coordinates.')
  if (process.argv.includes('--stop-test')) {
    console.log('Press Escape NOW while the helper types. Do not switch apps.')
    const typing = request('type', { bundleId, text: '\nStop test '.repeat(2000) }, 60_000)
    await assert.rejects(typing, /停止|监听/)
    assert.equal(inputEvent?.reason, 'escape', 'Must receive the real Escape event, not merely a timeout.')
    await assert.rejects(request('key', { bundleId, combo: 'space' }), /停止|监听/)
  }
  console.log(
    'PASS: native permissions, activation, new document, Unicode input, AX reference expiry, JPEG and window coordinates. Unsaved document remains open.',
  )
} finally {
  await request('release').catch(() => undefined)
  child.stdin.end()
  const kill = setTimeout(() => child.kill('SIGTERM'), 1000)
  kill.unref()
}
