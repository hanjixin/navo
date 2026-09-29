import { execFileSync } from 'node:child_process'

let cached: string | null = null

/** GUI apps on macOS don't inherit the login shell PATH; resolve it once so stdio MCP servers (npx, uvx…) are found. */
export function shellPath(): string {
  // AB_EXTRA_PATH lets tests (and power users) put extra tool directories first
  const extra = process.env.AB_EXTRA_PATH ? `${process.env.AB_EXTRA_PATH}:` : ''
  return extra + loginPath()
}

function loginPath(): string {
  if (cached) return cached
  cached = process.env.PATH ?? ''
  if (process.platform === 'win32') return cached
  try {
    const out = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'echo -n "__P__$PATH__P__"'], { timeout: 5000, encoding: 'utf8' })
    const m = /__P__(.*)__P__/.exec(out)
    if (m?.[1]) cached = m[1]
  } catch {
    /* keep process PATH */
  }
  return cached
}
