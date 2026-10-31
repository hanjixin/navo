// Copies extension/ to dist/extension/ with the app's version, ready to be bundled into the app
// (electron-builder extraResources) and imported with "Load unpacked".
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const out = 'dist/extension'
rmSync(out, { recursive: true, force: true })
cpSync('extension', out, { recursive: true })
const manifest = JSON.parse(readFileSync(`${out}/manifest.json`, 'utf8'))
manifest.version = JSON.parse(readFileSync('package.json', 'utf8')).version
writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n')
console.log(`extension ${manifest.version} → ${out}`)
