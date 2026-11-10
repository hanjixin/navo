import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { z } from 'zod'
import { createRuntimeFilesystem, type RuntimeFilesystemConfig } from './filesystem'

/** File tools for engines that do not provide DeepAgents' filesystem middleware. */
export function runtimeFileTools(config: RuntimeFilesystemConfig): StructuredToolInterface[] {
  const backend = createRuntimeFilesystem(config, async () => {})
  const roots = ['/workspace/', '/skills/', '/uploads/', ...config.mounts.map((mount) => `/ext/${mount.id}/`)]
  const pathOf = (value = '/workspace/') => {
    if (value.includes('\\') || value.includes('\0') || value.split('/').some((part) => part === '.' || part === '..'))
      throw new Error('Use an absolute virtual file path without traversal segments')
    const path = roots.includes(`${value}/`) ? `${value}/` : value
    if (!roots.some((root) => path.startsWith(root))) throw new Error('File path must be under /workspace/, /skills/, /uploads/ or an enabled /ext/ mount')
    return path
  }
  const writable = (value: string) => {
    const path = pathOf(value)
    if (!path.startsWith('/workspace/')) throw new Error('This directory is read-only; write artifacts under /workspace/')
    return path
  }
  const result = async (operation: Promise<unknown>) => {
    const value = (await operation) as { error?: string }
    if (value?.error) throw new Error(value.error)
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  }
  return [
    tool(async ({ file_path, offset, limit }) => result(backend.read(pathOf(file_path), offset, limit)), {
      name: 'read_file',
      description: '读取虚拟路径下的文本文件：/workspace/ 工作文件、/uploads/ 上传正文、/skills/ 和 /ext/ 下的 Skill。支持 offset / limit 分段读取。',
      schema: z.object({ file_path: z.string(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(2000).optional() }),
    }),
    tool(async ({ file_path, content }) => result(backend.write(writable(file_path), content)), {
      name: 'write_file',
      description: '写入 /workspace/ 下的文件，生成需要保留的工作产物。其他挂载目录只读。',
      schema: z.object({ file_path: z.string(), content: z.string() }),
    }),
    tool(async ({ file_path, old_string, new_string, replace_all }) => result(backend.edit(writable(file_path), old_string, new_string, replace_all)), {
      name: 'edit_file',
      description: '编辑 /workspace/ 下的文件，按精确文本替换内容。其他挂载目录只读。',
      schema: z.object({ file_path: z.string(), old_string: z.string(), new_string: z.string(), replace_all: z.boolean().optional() }),
    }),
    tool(async ({ path, pattern, glob }) => result(backend.grep(pattern, pathOf(path), glob)), {
      name: 'grep',
      description: '在指定虚拟目录下搜索文本，默认搜索 /workspace/；也可搜索 /uploads/、/skills/ 或具体 /ext/ 挂载。',
      schema: z.object({ pattern: z.string(), path: z.string().optional(), glob: z.string().optional() }),
    }),
    tool(
      async ({ path }) => {
        if (path === '/' || path === '/ext' || path === '/ext/')
          return JSON.stringify({ files: roots.filter((root) => path === '/' || root.startsWith('/ext/')).map((root) => ({ path: root, is_dir: true })) })
        return result(backend.ls(pathOf(path)))
      },
      {
        name: 'ls',
        description: '列出虚拟目录的文件；默认 /workspace/，使用 / 查看全部挂载目录。/skills/、/ext/ 和 /uploads/ 只读。',
        schema: z.object({ path: z.string().optional() }),
      },
    ),
  ] as unknown as StructuredToolInterface[]
}
