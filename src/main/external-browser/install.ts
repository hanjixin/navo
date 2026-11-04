import { cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
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

/** Compare only bundled files; extra destination entries are detected without reading their contents. */
function sameBundle(src: string, dest: string): boolean {
  try {
    if (!lstatSync(dest).isDirectory()) return false
    const entries = readdirSync(src, { withFileTypes: true })
    const destinationNames = new Set(readdirSync(dest))
    if (destinationNames.size !== entries.length) return false
    for (const entry of entries) {
      if (!destinationNames.has(entry.name)) return false
      const sourcePath = join(src, entry.name)
      const destinationPath = join(dest, entry.name)
      if (entry.isDirectory()) {
        if (!sameBundle(sourcePath, destinationPath)) return false
      } else if (entry.isFile()) {
        if (!lstatSync(destinationPath).isFile() || !readFileSync(sourcePath).equals(readFileSync(destinationPath))) return false
      } else return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * Copies the bundled extension to `dest` when its bundled contents change or it is missing. The folder itself
 * is kept: the browser remembers the path the user picked in "Load unpacked".
 */
export function installExtension(src: string, dest: string): InstallResult {
  const want = version(src)
  if (!want) throw new Error(`找不到 Navo 浏览器扩展（${src}），请重新安装 Navo`)
  mkdirSync(dest, { recursive: true })
  // only ever clear a folder that is empty or holds a copy of the extension
  if (readdirSync(dest).length && !isNavo(dest)) throw new Error(`${dest} 里已有其他文件，不是 Navo 扩展，请换一个文件夹`)
  if (version(dest) === want && sameBundle(src, dest)) return { dir: dest, updated: false }
  for (const entry of readdirSync(dest)) rmSync(join(dest, entry), { recursive: true, force: true })
  cpSync(src, dest, { recursive: true })
  return { dir: dest, updated: true }
}
