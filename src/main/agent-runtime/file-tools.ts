import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { z } from 'zod'
import { createRuntimeFilesystem, type RuntimeFilesystemConfig } from './filesystem'

const execCommand = promisify(exec)
const COMMAND_TIMEOUT = 15 * 60_000
const COMMAND_OUTPUT_LIMIT = 16 * 1024 * 1024

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
  const workspacePath = (value = '/workspace/') => {
    const virtualPath = pathOf(value)
    if (!virtualPath.startsWith('/workspace/')) throw new Error('Commands must run from /workspace/')
    return `${config.paths.workspace}/${virtualPath.slice('/workspace/'.length)}`
  }
  const runCommand = async ({ command, cwd, timeout_ms }: { command: string; cwd?: string; timeout_ms?: number }) => {
    const timeout = timeout_ms ?? COMMAND_TIMEOUT
    if (timeout < 1000 || timeout > COMMAND_TIMEOUT) throw new Error(`timeout_ms must be between 1000 and ${COMMAND_TIMEOUT}`)
    try {
      const { stdout, stderr } = await execCommand(command, {
        cwd: workspacePath(cwd),
        env: { ...process.env },
        timeout,
        maxBuffer: COMMAND_OUTPUT_LIMIT,
        windowsHide: true,
      })
      return JSON.stringify({ ok: true, exitCode: 0, stdout, stderr })
    } catch (error) {
      const cause = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; signal?: string; killed?: boolean }
      return JSON.stringify({
        ok: false,
        exitCode: typeof cause.code === 'number' ? cause.code : null,
        signal: cause.signal ?? null,
        killed: cause.killed === true,
        stdout: cause.stdout ?? '',
        stderr: cause.stderr ?? cause.message ?? String(error),
      })
    }
  }
  return [
    tool(runCommand, {
      name: 'run_command',
      description:
        '在项目工作目录 /workspace/ 中执行本机 Shell 命令。可使用网络、本机 Docker 和其他已安装命令处理二进制文件；结果包含退出码、标准输出和错误输出。命令执行前会按 Navo 审批规则请求确认。',
      schema: z.object({
        command: z.string().min(1).max(32_000),
        cwd: z.string().optional().describe('工作目录，只能是 /workspace/ 或其子目录'),
        timeout_ms: z.number().int().min(1000).max(COMMAND_TIMEOUT).optional(),
      }),
    }),
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
