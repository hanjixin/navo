// Runs native pure selection logic without launching the helper or accessing desktop apps.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

if (process.platform !== 'darwin') {
  console.log('SKIP native window selection: macOS only')
  process.exit(0)
}
const source = readFileSync('src/main/desktop/helper/Sources/NavoDesktop/main.swift', 'utf8')
const end = source.indexOf('final class Helper {')
assert.ok(end > 0, 'Pure helper functions precede the runtime')
const folder = mkdtempSync(join(tmpdir(), 'navo-window-selection-'))
try {
  const path = join(folder, 'checks.swift')
  writeFileSync(
    path,
    source.slice(0, end) +
      `
let main = CGRect(x: 100, y: 100, width: 1200, height: 900)
let preview = CGRect(x: 20, y: 20, width: 332, height: 301)
assert(selectedScreenshotIndex([(preview, "Computer Use"), (main, "Chat")], bounds: main, title: "Chat") == 1)
assert(selectedScreenshotIndex([(preview, "Computer Use")], bounds: main, title: "Chat") == nil)
assert(selectedScreenshotIndex([(main, "A"), (main, "B")], bounds: main, title: "B") == 1)
assert(selectedScreenshotIndex([(main, nil), (main, nil)], bounds: main, title: nil) == nil)
assert(selectedScreenshotIndex([(preview, "Preview"), (main, "Chat")], bounds: nil, title: nil) == nil)
assert(selectedScreenshotIndex([(main, "Chat")], bounds: nil, title: nil) == 0)
assert(selectedScreenshotIndex([], bounds: nil, title: nil) == nil)
print("PASS native window selection: main window over preview, exact title, ambiguity rejection and single-window fallback")
`,
  )
  const result = spawnSync('swift', [path], { stdio: 'inherit' })
  assert.equal(result.status, 0, 'Native selection assertions pass')
} finally {
  rmSync(folder, { recursive: true, force: true })
}
