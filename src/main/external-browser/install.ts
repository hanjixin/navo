import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export interface InstallResult {
  dir: string
  /** files were (re)written: a loaded extension has to reload to pick them up */
  updated: boolean
}

const version = (dir: string): string | null => {
  try {
    return (JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

const isNavo = (dir: string): boolean => {
  try {
    return (JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { name?: string }).name === 'Navo'
  } catch {
    return false
  }
}

/**
 * Copies the bundled extension to `dest` when it is missing or another version. The folder itself
 * is kept: the browser remembers the path the user picked in "Load unpacked".
 */
export function installExtension(src: string, dest: string): InstallResult {
  const want = version(src)
  if (!want) throw new Error(`找不到 Navo 浏览器扩展（${src}），请重新安装 Navo`)
  if (version(dest) === want) return { dir: dest, updated: false }
  mkdirSync(dest, { recursive: true })
  // only ever clear a folder that is empty or holds a copy of the extension
  if (readdirSync(dest).length && !isNavo(dest)) throw new Error(`${dest} 里已有其他文件，不是 Navo 扩展，请换一个文件夹`)
  for (const entry of readdirSync(dest)) rmSync(join(dest, entry), { recursive: true, force: true })
  cpSync(src, dest, { recursive: true })
  return { dir: dest, updated: true }
}
