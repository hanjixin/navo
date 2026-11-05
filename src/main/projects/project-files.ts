import { createHash } from 'node:crypto'
import { readdir, lstat, open } from 'node:fs/promises'
import type { ProjectFilePage, ProjectFileRef, ProjectFileSearchResult } from '@shared/files-query'
import { files } from '../files/file-service'
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
  private searches = new Map<string, AbortController>()

  async listPage(projectId: string, path = '', showHidden = false, cursor?: string, limit = 100): Promise<ProjectFilePage> {
    const root = rootOf(projectId)
    const entry = resolveEntry(root, path)
    if (!entry.stat.isDirectory()) throw new Error(t('请选择目录'))
    const candidates = (await readdir(entry.abs, { withFileTypes: true }))
      .filter((child) => (showHidden || !child.name.startsWith('.')) && !child.isSymbolicLink() && (child.isDirectory() || child.isFile()))
      .sort((a, b) => (a.isDirectory() === b.isDirectory() ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.isDirectory() ? -1 : 1))
    const revision = createHash('sha256')
      .update(JSON.stringify([root, entry.path, showHidden, candidates.map((e) => [e.name, e.isDirectory()])]))
      .digest('hex')
    let offset = 0
    if (cursor) {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as { revision: string; offset: number }
      if (decoded.revision !== revision || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0) throw new Error(t('目录已变化，请刷新后重试'))
      offset = decoded.offset
    }
    const count = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 100
    const entries = (
      await Promise.all(
        candidates.slice(offset, offset + count).map(async (child) => {
          try {
            const childPath = [entry.path, child.name].filter(Boolean).join('/')
            const stat = await lstat(join(entry.abs, child.name))
            if (!stat.isFile() && !stat.isDirectory()) return null
            return {
              name: child.name,
              path: childPath,
              kind: stat.isDirectory() ? ('directory' as const) : ('file' as const),
              size: stat.size,
              modifiedAt: stat.mtimeMs,
            }
          } catch {
            return null
          }
        }),
      )
    ).filter((entry): entry is ProjectFileEntry => entry !== null)
    if (rootOf(projectId) !== root) throw new Error(t('项目目录已变化，请重新选择文件'))
    return {
      root,
      path: entry.path,
      entries,
      nextCursor: offset + count < candidates.length ? Buffer.from(JSON.stringify({ revision, offset: offset + count })).toString('base64url') : null,
    }
  }

  cancelSearch(requestId: string): void {
    this.searches.get(requestId)?.abort()
  }

  async search(projectId: string, query: string, requestId: string, showHidden = false): Promise<ProjectFileSearchResult> {
    this.cancelSearch(requestId)
    const root = rootOf(projectId)
    const controller = new AbortController()
    this.searches.set(requestId, controller)
    const entries: ProjectFileEntry[] = []
    const needle = query.trim().toLocaleLowerCase()
    const pending = ['']
    const started = Date.now()
    let scanned = 0
    let truncated = false
    try {
      while (needle && pending.length && !controller.signal.aborted) {
        const path = pending.shift()!
        let children
        try {
          children = await readdir(resolveEntry(root, path).abs, { withFileTypes: true })
        } catch {
          continue
        }
        for (const child of children) {
          if (controller.signal.aborted) break
          if (++scanned > 20_000 || Date.now() - started >= 3000 || entries.length >= 200) {
            truncated = true
            break
          }
          if (child.isSymbolicLink() || child.name === '.git' || child.name === 'node_modules' || (!showHidden && child.name.startsWith('.'))) continue
          if (!child.isFile() && !child.isDirectory()) continue
          const childPath = [path, child.name].filter(Boolean).join('/')
          if (child.isDirectory()) pending.push(childPath)
          if (!childPath.toLocaleLowerCase().includes(needle)) continue
          try {
            const stat = await lstat(join(root, childPath))
            if (!stat.isFile() && !stat.isDirectory()) continue
            entries.push({ name: child.name, path: childPath, kind: stat.isDirectory() ? 'directory' : 'file', size: stat.size, modifiedAt: stat.mtimeMs })
          } catch {
            /* Entry disappeared during search. */
          }
        }
        if (truncated) break
      }
      return { root, entries, truncated, cancelled: controller.signal.aborted }
    } finally {
      if (this.searches.get(requestId) === controller) this.searches.delete(requestId)
    }
  }

  async captureReferences(refs: ProjectFileRef[], expectedProjectId: string | null): Promise<{ fileIds: string[]; sources: Record<string, ProjectFileRef> }> {
    const fileIds: string[] = []
    const sources: Record<string, ProjectFileRef> = {}
    for (const ref of refs) {
      if (ref.projectId !== expectedProjectId || ref.root !== rootOf(ref.projectId)) throw new Error(t('项目目录已变化，请重新选择文件'))
      const resolved = resolveEntry(ref.root, ref.path)
      if (!resolved.stat.isFile()) throw new Error(t('请选择文件'))
      if (resolved.stat.size > 300 * MB) throw new Error(t('文件太大，无法预览，请在文件管理器中打开'))
      const handle = await open(resolved.abs, constants.O_RDONLY | constants.O_NOFOLLOW)
      let data: Buffer
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.size > 300 * MB) throw new Error(t('请选择文件'))
        data = await handle.readFile()
        if (data.length > 300 * MB) throw new Error(t('文件太大，无法预览，请在文件管理器中打开'))
      } finally {
        await handle.close()
      }
      // Resolve again after async I/O so a changed project root never sends an old location.
      if (ref.root !== rootOf(ref.projectId)) throw new Error(t('项目目录已变化，请重新选择文件'))
      resolveEntry(ref.root, ref.path)
      const record = files.addData(resolved.path.split('/').at(-1)!, data)
      fileIds.push(record.id)
      sources[record.id] = ref
    }
    return { fileIds, sources }
  }

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
