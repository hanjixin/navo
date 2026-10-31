import { pageRuntime } from './page-runtime'

/** No Electron imports: shared with the driver for tabs in the user's own browser. */

export const HOME = 'https://www.bing.com'

/** The page runtime (`__agent`) as source, evaluated in the agent's isolated world. */
export const RUNTIME_SRC = `(${pageRuntime.toString()})();`

export function normalizeUrl(input: string): string {
  const s = input.trim()
  if (!s) return HOME
  if (/^(https?|file|about|data):/i.test(s)) return s
  if (/^localhost(:\d+)?(\/|$)/.test(s) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s)) return `https://${s}`
  return `https://www.bing.com/search?q=${encodeURIComponent(s)}`
}
