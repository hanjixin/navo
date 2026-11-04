import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { t } from '@shared/i18n'

export const VIRTUAL_WORKSPACE = '/workspace/'
export function insideWorkspace(root: string, path: string): boolean {
  const rel = relative(root, path)
  return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
export function workspaceFile(root: string, path: string, allowMissing = false): string {
  const abs = resolve(root, path.replace(/^\/+/, ''))
  let check = abs
  if (allowMissing) {
    try {
      lstatSync(abs)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      check = dirname(abs)
    }
  }
  const realRoot = realpathSync(root)
  const realCheck = realpathSync(check)
  if (!insideWorkspace(root, abs) || (realCheck !== realRoot && !insideWorkspace(realRoot, realCheck))) throw new Error(t('文件路径超出工作目录'))
  return abs
}
export function storedWorkspacePath(abs: string, root: string, defaultRoot: string): string {
  return root === defaultRoot ? VIRTUAL_WORKSPACE + relative(root, abs).split(sep).join('/') : abs
}
export function outputAbsolutePath(row: { path: string; workspace_root?: string | null }, defaultRoot: string): string {
  // A custom-root row always stores an absolute path, including real directories named /workspace.
  if (row.workspace_root && row.workspace_root !== defaultRoot) return row.path
  return row.path.startsWith(VIRTUAL_WORKSPACE) ? resolve(row.workspace_root ?? defaultRoot, row.path.slice(VIRTUAL_WORKSPACE.length)) : row.path
}
