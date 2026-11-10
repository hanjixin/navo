import { FilesystemBackend } from 'deepagents'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

type AnyResult = Record<string, unknown> & { error?: string }
const EXTERNAL_READ_ONLY = '外部 Skill 目录是只读的；如需修改，请先在「Skill」页面复制到本地。'

/**
 * Read-only view of an external skill folder that only exposes the allowed top-level directories.
 * External folders are shared with other agents (Claude Code, Codex, …), so the agent must never write
 * to them, and disabled skills — or siblings of a single mounted skill — stay invisible.
 */
export class ScopedSkillBackend {
  private inner: FilesystemBackend

  constructor(
    private readonly rootDir: string,
    /** top-level entries to expose; null = everything */
    private readonly allowed: Set<string> | null,
    /** what a write attempt is told */
    private readonly readOnlyMessage = EXTERNAL_READ_ONLY,
  ) {
    this.inner = new FilesystemBackend({ rootDir, virtualMode: true })
  }

  private top(p?: string | null): string {
    return (p ?? '/').replace(/^\/+/, '').split('/')[0]
  }

  private async visible(p?: string | null): Promise<boolean> {
    if (!this.allowed) return true
    const key = p ?? '/'
    if (key.includes('\\') || key.includes('\0') || key.split('/').some((part) => part === '.' || part === '..')) return false
    const t = this.top(key)
    if (t && !this.allowed.has(t)) return false
    try {
      const [root, target] = await Promise.all([realpath(this.rootDir), realpath(resolve(this.rootDir, key.replace(/^\/+/, '')))])
      const actual = relative(root, target)
      if (actual === '..' || actual.startsWith(`..${sep}`) || isAbsolute(actual)) return false
      return actual === '' || this.allowed.has(actual.split(sep)[0])
    } catch {
      return false
    }
  }

  private async filter<T extends AnyResult>(res: T, key: 'files' | 'matches'): Promise<T> {
    const list = res?.[key]
    if (!Array.isArray(list)) return res
    const visible = await Promise.all(list.map((item: { path?: string }) => typeof item.path === 'string' && this.visible(item.path)))
    return { ...res, [key]: list.filter((_, index) => visible[index]) }
  }

  async ls(path: string) {
    if (!(await this.visible(path))) return { error: `路径不存在: ${path}` }
    return this.filter((await this.inner.ls(path)) as AnyResult, 'files')
  }

  async read(filePath: string, offset?: number, limit?: number) {
    if (!(await this.visible(filePath))) return { error: `文件不存在: ${filePath}` }
    return this.inner.read(filePath, offset, limit)
  }

  async readRaw(filePath: string) {
    if (!(await this.visible(filePath))) return { error: `文件不存在: ${filePath}` }
    return this.inner.readRaw(filePath)
  }

  async grep(pattern: string, path?: string | null, glob?: string | null, maxCount?: number | null) {
    if (!(await this.visible(path))) return { matches: [] }
    return this.filter((await this.inner.grep(pattern, path ?? undefined, glob, maxCount)) as AnyResult, 'matches')
  }

  async glob(pattern: string, path?: string) {
    if (!(await this.visible(path))) return { files: [] }
    return this.filter((await this.inner.glob(pattern, path)) as AnyResult, 'files')
  }

  async downloadFiles(paths: string[]) {
    const visible = await Promise.all(paths.map((path) => this.visible(path)))
    return this.inner.downloadFiles(paths.filter((_, index) => visible[index]))
  }

  async write() {
    return { error: this.readOnlyMessage }
  }

  async edit() {
    return { error: this.readOnlyMessage }
  }

  async delete() {
    return { error: this.readOnlyMessage }
  }

  async uploadFiles(files: Array<[string, Uint8Array]>) {
    return files.map(([path]) => ({ path, error: 'permission_denied' as const }))
  }
}
