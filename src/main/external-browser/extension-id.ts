import { createHash } from 'node:crypto'

/** Chrome's extension ID for a manifest `key`: SHA-256 of the key, first 16 bytes, hex digits mapped 0-f → a-p. */
export function extensionIdFromKey(base64Der: string): string {
  const hex = createHash('sha256').update(Buffer.from(base64Der, 'base64')).digest('hex').slice(0, 32)
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
}
