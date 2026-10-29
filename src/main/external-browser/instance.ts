import { BRIDGE_PORTS, EXTENSION_ID } from '@shared/extension'
import { secrets } from '../core/secrets'
import { Bridge } from './bridge'

/** Navo's bridge to its browser extension; the pairing token is kept in the system keychain. */
export const bridge = new Bridge({
  ports: BRIDGE_PORTS,
  extensionId: EXTENSION_ID,
  tokens: { get: () => secrets.get('extension.token'), set: (t) => secrets.set('extension.token', t) },
})
