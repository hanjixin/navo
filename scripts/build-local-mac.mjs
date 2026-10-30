// Explicit ad-hoc signed app for local desktop-permission testing. Never publishes or launches.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  })
  if (result.error || result.status !== 0) {
    if (result.stdout) console.error(result.stdout)
    if (result.stderr) console.error(result.stderr)
    throw result.error ?? new Error(`${command} failed (${result.status})`)
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}
function identifier(path, expected) {
  const details = run('codesign', ['--display', '--verbose=4', path], true)
  const actual = details.match(/^Identifier=(.+)$/m)?.[1]
  if (actual !== expected) throw new Error(`Signature identifier mismatch for ${path}: expected ${expected}, got ${actual ?? 'missing'}`)
  if (!/^Signature=adhoc$/m.test(details)) throw new Error(`Expected an ad-hoc signature: ${path}`)
}

if (process.platform !== 'darwin') throw new Error('Local macOS packaging requires a Mac.')
if (!['arm64', 'x64'].includes(process.arch)) throw new Error(`Unsupported local architecture: ${process.arch}`)
const parent = resolve(root, 'release/local-mac')
mkdirSync(parent, { recursive: true })
// Unique output protects any running local build and release/desktop-live/Navo.app.
const output = mkdtempSync(join(parent, 'build-'))
run(process.execPath, ['scripts/build-desktop-helper.mjs'])
run(process.execPath, ['scripts/build-extension.mjs'])
run('pnpm', ['exec', 'electron-vite', 'build'])
try {
  run('pnpm', [
    'exec',
    'electron-builder',
    '--mac',
    '--dir',
    `--${process.arch}`,
    '--publish',
    'never',
    `-c.directories.output=${output}`,
    '-c.mac.identity=-',
    '-c.mac.notarize=false',
  ])
} finally {
  // Restore the development Electron ABI after builder prepares native dependencies.
  run('pnpm', ['exec', 'electron-builder', 'install-app-deps'])
}
const apps = readdirSync(output, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(output, entry.name, 'Navo.app'))
  .filter(existsSync)
if (apps.length !== 1) throw new Error(`Expected one Navo.app in ${output}; found ${apps.length}`)
const app = apps[0]
const helper = join(app, 'Contents/Resources/desktop/navo-desktop')
// Builder may derive a UUID-suffixed identifier when re-signing the embedded executable.
// Restore its stable local identity, preserving the builder's entitlements and hardened runtime.
// Re-seal only the outer bundle afterwards; --deep signing would rewrite nested identities again.
for (const [path, id] of [
  [helper, 'com.navo.desktop'],
  [app, 'com.navo.app'],
]) {
  run('codesign', ['--force', '--sign', '-', '--identifier', id, '--preserve-metadata=entitlements,flags,runtime', '--options', 'runtime', path])
}
run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
run('codesign', ['--verify', '--strict', '--verbose=2', helper])
identifier(app, 'com.navo.app')
identifier(helper, 'com.navo.desktop')
console.log(`Verified local app: ${app}`)
console.log(`Launch through Finder, or: open ${JSON.stringify(app)}`)
console.log('Grant permissions to this build. After code changes, remove stale permission entries and add this app again.')
