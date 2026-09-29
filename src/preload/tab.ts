// Preload for automated browser tabs. Runs in the isolated world (id 999) that the agent runtime,
// site plugins and the recorder share. Nothing is exposed to the page's main world.
import { ipcRenderer } from 'electron'

;(globalThis as unknown as { __agentBridge: unknown }).__agentBridge = {
  send(channel: 'recorder' | 'plugin-log', payload: unknown) {
    ipcRenderer.send(`tab:${channel}`, payload)
  },
}
