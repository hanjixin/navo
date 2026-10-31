// Run once: gives the Navo extension a fixed public key, so its ID is the same on every machine
// ("Load unpacked" derives the ID from `key`). The private key is not needed and is discarded.
//   node scripts/gen-extension-key.mjs
import { generateKeyPairSync } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'extension/manifest.json'
const manifest = JSON.parse(readFileSync(file, 'utf8'))
if (manifest.key && !process.argv.includes('--force')) {
  console.log('extension/manifest.json already has a key (use --force to replace it — the extension ID changes)')
  process.exit(0)
}
const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
manifest.key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
console.log('key written to extension/manifest.json')
