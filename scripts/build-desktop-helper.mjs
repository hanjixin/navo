import { spawnSync } from 'node:child_process'
import { mkdirSync, copyFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  console.log('Desktop helper is macOS-only; skipping.')
  process.exit(0)
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(root, 'src/main/desktop/helper')
const output = resolve(root, 'dist/desktop/navo-desktop')
const universal = process.argv.includes('--universal')
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  if (result.status !== 0) {
    if (result.stdout) console.error(result.stdout)
    if (result.error) console.error(result.error.message)
    process.exit(result.status || 1)
  }
  return result.stdout.trim()
}
function build(arch) {
  const args = ['build', '--package-path', source, '-c', 'release', ...(arch ? ['--arch', arch] : [])]
  run('swift', args)
  return resolve(run('swift', [...args, '--show-bin-path']), 'navo-desktop')
}
mkdirSync(dirname(output), { recursive: true })
if (universal) {
  // Two independent builds also work with Command Line Tools (multi-arch SwiftPM needs Xcode).
  const arm = build('arm64')
  const intel = build('x86_64')
  run('lipo', ['-create', arm, intel, '-output', output])
} else copyFileSync(build(), output)
run('codesign', ['--force', '--sign', '-', output])
console.log(`Desktop helper: ${output}`)
