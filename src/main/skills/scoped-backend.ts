import { FilesystemBackend } from 'deepagents'

type AnyResult = Record<string, unknown> & { error?: string }
const READ_ONLY = { error: '外部 Skill 目录是只读的；如需修改，请先在「Skill」页面复制到本地。' }

/**
 * Read-only view of an external skill folder that only exposes the allowed top-level directories.
 * External folders are shared with other agents (Claude Code, Codex, …), so the agent must never write
 * to them, and disabled skills — or siblings of a single mounted skill — stay invisible.
 */
export class ScopedSkillBackend {
  private inner: FilesystemBackend

  constructor(
    rootDir: string,
    /** top-level entries to expose; null = everything */
    private readonly allowed: Set<string> | null,
  ) {
    this.inner = new FilesystemBackend({ rootDir, virtualMode: true })
  }

  private top(p?: string | null): string {
    return (p ?? '/').replace(/^\/+/, '').split('/')[0]
  }

  private visible(p?: string | null): boolean {
    const t = this.top(p)
    return t === '' || !this.allowed || this.allowed.has(t)
  }

  private filter<T extends AnyResult>(res: T, key: 'files' | 'matches'): T {
    const list = res?.[key]
    if (!Array.isArray(list)) return res
    return { ...res, [key]: list.filter((x: { path?: string }) => this.visible(x.path)) }
  }

  async ls(path: string) {
    if (!this.visible(path)) return { error: `路径不存在: ${path}` }
    return this.filter((await this.inner.ls(path)) as AnyResult, 'files')
  }

  async read(filePath: string, offset?: number, limit?: number) {
    if (!this.visible(filePath)) return { error: `文件不存在: ${filePath}` }
    return this.inner.read(filePath, offset, limit)
  }

  async readRaw(filePath: string) {
    if (!this.visible(filePath)) return { error: `文件不存在: ${filePath}` }
    return this.inner.readRaw(filePath)
  }

  async grep(pattern: string, path?: string | null, glob?: string | null, maxCount?: number | null) {
    if (!this.visible(path)) return { matches: [] }
    return this.filter((await this.inner.grep(pattern, path ?? undefined, glob, maxCount)) as AnyResult, 'matches')
  }

  async glob(pattern: string, path?: string) {
    if (!this.visible(path)) return { files: [] }
    return this.filter((await this.inner.glob(pattern, path)) as AnyResult, 'files')
  }

  async downloadFiles(paths: string[]) {
    return this.inner.downloadFiles(paths.filter((p) => this.visible(p)))
  }

  async write() {
    return READ_ONLY
  }

  async edit() {
    return READ_ONLY
  }

  async delete() {
    return READ_ONLY
  }

  async uploadFiles(files: Array<[string, Uint8Array]>) {
    return files.map(([path]) => ({ path, error: 'permission_denied' as const }))
  }
}
