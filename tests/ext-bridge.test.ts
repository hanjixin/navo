import { describe, expect, it } from 'vitest'
import manifest from '../extension/manifest.json'
import { BRIDGE_PORTS, EXTENSION_ID } from '../src/shared/extension'
import { extensionIdFromKey } from '../src/main/external-browser/extension-id'

describe('extension id', () => {
  it('is derived from the manifest key', () => {
    expect(extensionIdFromKey(manifest.key)).toBe(EXTENSION_ID)
    expect(EXTENSION_ID).toMatch(/^[a-p]{32}$/)
    expect(BRIDGE_PORTS).toEqual([38810, 38811, 38812, 38813, 38814, 38815, 38816, 38817, 38818, 38819])
  })
})
