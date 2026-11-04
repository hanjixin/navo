import { shell } from 'electron'
import { type Stats, accessSync, constants, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, sep, win32 } from 'node:path'
import type { OutputPreview, ProjectFileEntry, ProjectFileListing } from '@shared/types'
import { t } from '@shared/i18n'
import { paths } from '../core/paths'
import { outputs } from '../outputs/outputs-service'
import { kindOf } from '../outputs/convert'
import { decodeText } from '../files/text-utils'
import { projects } from './project-service'

const MAX_ENTRIES = 500
const MB = 1024 * 1024

/** Re-resolve the selected project on every request; no write permission is needed for browsing. */
function rootOf(projectId: string): string {
  const project = projects.basic(projectId)
  if (!project) throw new Error(t('项目不存在'))
  try {
    const root = realpathSync(project.workingDirectory ?? paths.workspace)
    if (!statSync(root).isDirectory()) throw new Error('not a directory')
    accessSync(root, constants.R_OK | constants.X_OK)
    return root
  } catch {
    throw new Error(t('项目目录不存在或无法读取'))
  }
}

function resolveEntry(root: string, path: string): { abs: string; path: string; stat: Stats } {
  if (typeof path !== 'string' || path.includes('\0') || path.includes('\\') || isAbsolute(path) || win32.isAbsolute(path) || path.split('/').includes('..')) {
    throw new Error(t('文件路径超出工作目录'))
  }
  const parts = path.split('/').filter((part) => part && part !== '.')
  let abs = root
  for (const part of parts) {
    abs = join(abs, part)
    if (lstatSync(abs).isSymbolicLink()) throw new Error(t('不支持浏览符号链接'))
  }
  const real = realpathSync(abs)
  const rel = relative(root, real)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(t('文件路径超出工作目录'))
  const stat = lstatSync(abs)
  if (!stat.isDirectory() && !stat.isFile()) throw new Error(t('只支持普通文件和目录'))
  return { abs, path: parts.join('/'), stat }
}

class ProjectFilesService {
  list(projectId: string, path = '', showHidden = false): ProjectFileListing {
    const root = rootOf(projectId)
    const entry = resolveEntry(root, path)
    if (!entry.stat.isDirectory()) throw new Error(t('请选择目录'))
    const entries: ProjectFileEntry[] = []
    const candidates = readdirSync(entry.abs, { withFileTypes: true })
      .filter((child) => (showHidden || !child.name.startsWith('.')) && !child.isSymbolicLink() && (child.isDirectory() || child.isFile()))
      .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
    for (const child of candidates.slice(0, MAX_ENTRIES)) {
      try {
        const childPath = [entry.path, child.name].filter(Boolean).join('/')
        const resolved = resolveEntry(root, childPath)
        entries.push({
          name: child.name,
          path: childPath,
          kind: resolved.stat.isDirectory() ? 'directory' : 'file',
          size: Number(resolved.stat.size),
          modifiedAt: Number(resolved.stat.mtimeMs),
        })
      } catch {
        // A child may disappear or become inaccessible while the directory is being listed.
      }
    }
    return { root, path: entry.path, entries, truncated: candidates.length > MAX_ENTRIES }
  }

  async preview(projectId: string, path: string): Promise<OutputPreview> {
    const { abs, stat } = resolveEntry(rootOf(projectId), path)
    if (!stat.isFile()) throw new Error(t('请选择文件'))
    const kind = kindOf(abs)
    const office = kind === 'pdf' || kind === 'document' || /\.(xlsx|xls)$/i.test(abs)
    const maximum = kind === 'image' ? 15 * MB : office ? 20 * MB : 2 * MB
    if (stat.size > maximum) return { kind: 'other', message: t('文件太大，无法预览，请在文件管理器中打开') }
    if (kind === 'image' || office) return outputs.previewFile(abs)
    const buffer = readFileSync(abs)
    const { text } = decodeText(buffer)
    if (
      [...text.slice(0, 8192)].some((char) => {
        const code = char.charCodeAt(0)
        return code < 9 || (code > 13 && code < 32)
      })
    )
      return { kind: 'other', message: t('二进制文件无法预览') }
    if (kind === 'other') return { kind: 'text', text: text.slice(0, 400_000), truncated: text.length > 400_000 }
    return outputs.previewFile(abs)
  }

  reveal(projectId: string, path: string): void {
    const { abs } = resolveEntry(rootOf(projectId), path)
    shell.showItemInFolder(abs)
  }

  async openDirectory(projectId: string): Promise<void> {
    const error = await shell.openPath(rootOf(projectId))
    if (error) throw new Error(error)
  }
}

export const projectFiles = new ProjectFilesService()
