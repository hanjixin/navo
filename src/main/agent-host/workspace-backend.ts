import { FilesystemBackend } from 'deepagents'

/** Report only successful mutations, with the mounted backend's relative path. */
export class WorkspaceBackend extends FilesystemBackend {
  constructor(
    rootDir: string,
    private readonly changed: (path: string) => Promise<void>,
  ) {
    super({ rootDir, virtualMode: true })
  }
  override async write(...args: Parameters<FilesystemBackend['write']>) {
    const result = await super.write(...args)
    if (!result.error) await this.changed(args[0])
    return result
  }
  override async edit(...args: Parameters<FilesystemBackend['edit']>) {
    const result = await super.edit(...args)
    if (!result.error) await this.changed(args[0])
    return result
  }
  override async uploadFiles(...args: Parameters<FilesystemBackend['uploadFiles']>) {
    const results = await super.uploadFiles(...args)
    for (const result of results) if (!result.error) await this.changed(result.path)
    return results
  }
}
