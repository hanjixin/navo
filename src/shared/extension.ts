/** ID of the Navo browser extension: fixed by the `key` in extension/manifest.json. */
export const EXTENSION_ID = 'ogcpihpklecohklnmafejcmbpddohcgh'

/** Local ports the bridge tries in order; the extension probes the same list to find Navo. */
export const BRIDGE_PORTS = Array.from({ length: 10 }, (_, i) => 38810 + i)
