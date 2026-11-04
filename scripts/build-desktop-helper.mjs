import { spawnSync } from 'node:child_process'
import { mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (!['darwin', 'win32'].includes(process.platform)) {
  console.log('Desktop helper supports macOS and Windows; skipping this platform.')
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
if (process.platform === 'win32') {
  const requestedArch = process.argv.find((arg) => arg.startsWith('--arch='))?.slice('--arch='.length)
  const architectures = universal ? ['x64', 'arm64'] : [requestedArch ?? process.arch]
  for (const arch of architectures) {
    if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported Windows desktop architecture: ${arch}`)
    const rid = `win-${arch}`
    const destination = resolve(root, 'dist/desktop', rid)
    // Isolate architectures and remove old runtime files before a new self-contained publish.
    rmSync(destination, { recursive: true, force: true })
    run('dotnet', [
      'publish',
      resolve(root, 'src/main/desktop/helper-windows/NavoDesktop.csproj'),
      '--configuration',
      'Release',
      '--runtime',
      rid,
      '--self-contained',
      'true',
      '-p:PublishSingleFile=false',
      '-p:PublishTrimmed=false',
      '--output',
      destination,
    ])
    console.log(`Desktop helper: ${resolve(destination, 'navo-desktop.exe')}`)
  }
  process.exit(0)
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
run('codesign', ['--force', '--sign', '-', '--identifier', 'com.navo.desktop', output])
console.log(`Desktop helper: ${output}`)
