import { execFile, spawn } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { shellPath } from '../core/shell-env'
import { workspaceFile } from '../outputs/workspace-paths'

export const COMMAND_TIMEOUT = 15 * 60_000
const OUTPUT_LIMIT = 32 * 1024

function captureOutput() {
  const chunks: Buffer[] = []
  let size = 0
  let truncated = false
  return {
    append(chunk: Buffer) {
      const remaining = OUTPUT_LIMIT - size
      if (chunk.length > remaining) truncated = true
      if (remaining > 0) {
        const part = chunk.subarray(0, remaining)
        chunks.push(part)
        size += part.length
      }
    },
    text() {
      return Buffer.concat(chunks, size).toString('utf8') + (truncated ? '\n[Output truncated]' : '')
    },
  }
}

function fileVersion(root: string, path: string): string | null {
  try {
    const stat = statSync(workspaceFile(root, path), { bigint: true })
    return stat.isFile() ? `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Stop the process tree started for this particular command. */
function stopProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
    return new Promise((resolve, reject) => {
      execFile(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return Promise.reject(error)
  }
  return Promise.resolve()
}

export async function runLocalCommand(options: { root: string; directory: string; command: string; timeout: number; outputs: string[]; signal?: AbortSignal }) {
  const { root, command, directory, timeout, outputs, signal } = options
  signal?.throwIfAborted()
  const cwd = realpathSync(directory ? workspaceFile(root, directory) : root)
  const before = new Map(outputs.map((path) => [path, fileVersion(root, path)]))
  const stdout = captureOutput()
  const stderr = captureOutput()
  let stopped: 'cancelled' | 'timed_out' | undefined
  let startError: string | undefined
  const child = spawn(command, {
    cwd,
    env: { ...process.env, PATH: shellPath() },
    shell: true,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', stdout.append)
  child.stderr.on('data', stderr.append)
  child.on('error', (error) => {
    startError = error.message
  })
  let stopping: Promise<void> | undefined
  const stop = (reason: NonNullable<typeof stopped>) => {
    if (stopped) return
    stopped = reason
    const pid = child.pid
    if (pid) {
      stopping = stopProcessTree(pid).catch(() => {
        child.kill('SIGKILL')
      })
    }
  }
  const abort = () => stop('cancelled')
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => stop('timed_out'), timeout)
  const { code, exitSignal } = await new Promise<{ code: number | null; exitSignal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, exitSignal) => resolve({ code, exitSignal }))
  }).finally(() => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  })
  await stopping
  const ok = code === 0 && !stopped && !startError
  const outputPaths: string[] = []
  const skippedOutputs: string[] = []
  if (ok) {
    for (const path of outputs) {
      try {
        const after = fileVersion(root, path)
        if (after && after !== before.get(path)) {
          outputPaths.push(path)
          continue
        }
      } catch {
        // The command can replace a directory with a symlink. Recheck every output after it exits.
      }
      skippedOutputs.push(path)
    }
  }
  return {
    status: ok ? ('success' as const) : ('error' as const),
    outputPaths,
    content: JSON.stringify({
      ok,
      exitCode: code,
      signal: exitSignal,
      ...(stopped ? { reason: stopped } : {}),
      ...(startError ? { error: startError } : {}),
      stdout: stdout.text(),
      stderr: stderr.text(),
      ...(skippedOutputs.length ? { skippedOutputs } : {}),
    }),
  }
}
