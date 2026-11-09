import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { shellPath } from '../core/shell-env'

export interface JsonLineProcessOptions {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  signal: AbortSignal
  onMessage(message: Record<string, unknown>): void
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** A dedicated, shell-free process. Only its own process group is terminated. */
export class JsonLineProcess {
  readonly failure: Promise<never>
  readonly closed: Promise<{ code: number | null; signal: string | null; stderr: string }>
  private child: ChildProcessWithoutNullStreams
  private rejectFailure!: (reason: Error) => void
  private pending = new Map<string, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private buffer = ''
  private stderr = ''
  private stopped = false
  private exited = false
  private stopTask?: Promise<void>
  private abortListener: () => void

  constructor(private options: JsonLineProcessOptions) {
    if (options.signal.aborted) throw new Error('Runtime operation aborted')
    this.failure = new Promise((_, reject) => {
      this.rejectFailure = reject
    })
    void this.failure.catch(() => {})
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: { ...process.env, PATH: shellPath(), ...options.env },
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.closed = new Promise((resolve) => {
      this.child.once('close', (code, signal) => {
        this.exited = true
        options.signal.removeEventListener('abort', this.abortListener)
        if (!this.stopped) this.fail(new Error(`Runtime exited before completion (${code ?? signal ?? 'unknown'})`))
        resolve({ code, signal, stderr: this.stderr })
      })
    })
    this.abortListener = () => {
      const error = new Error('Runtime operation aborted')
      error.name = 'AbortError'
      this.fail(error)
      void this.stop()
    }
    options.signal.addEventListener('abort', this.abortListener, { once: true })
    this.child.on('error', (error) => this.fail(error))
    this.child.stdin.on('error', (error) => {
      if (!this.stopped) this.fail(error)
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4096)
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.consume(chunk))
  }

  private consume(chunk: string): void {
    if (this.stopped) return
    this.buffer += chunk
    let newline: number
    while (!this.stopped && (newline = this.buffer.indexOf('\n')) >= 0) {
      if (Buffer.byteLength(this.buffer.slice(0, newline)) > 8 * 1024 * 1024) {
        this.fail(new Error('Runtime JSON line exceeded 8 MB'))
        return
      }
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object')
        const message = record(parsed)
        const id = message.id == null ? undefined : String(message.id)
        const pending = id && !message.method ? this.pending.get(id) : undefined
        if (pending && id) {
          this.pending.delete(id)
          clearTimeout(pending.timer)
          if (message.error || message.success === false) {
            pending.reject(new Error(typeof message.error === 'string' ? message.error : String(record(message.error).message ?? 'Runtime request failed')))
          } else pending.resolve(message)
        } else this.options.onMessage(message)
      } catch (error) {
        this.fail(
          new Error(
            error instanceof SyntaxError
              ? 'Invalid runtime protocol: malformed JSON record'
              : `Invalid runtime protocol: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
      }
    }
    if (Buffer.byteLength(this.buffer) > 8 * 1024 * 1024) this.fail(new Error('Runtime JSON line exceeded 8 MB'))
  }

  send(message: unknown): void {
    if (this.stopped || this.exited || this.options.signal.aborted) throw new Error('Runtime process is closed')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  endInput(): void {
    if (!this.stopped) this.child.stdin.end()
  }

  request(
    message: Record<string, unknown>,
    options: { timeoutMs?: number; onResponse?: (message: Record<string, unknown>) => void } = {},
  ): Promise<Record<string, unknown>> {
    const id = String(message.id ?? randomUUID())
    if (this.pending.has(id)) return Promise.reject(new Error('Duplicate runtime request ID'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Runtime request timed out: ${String(message.method ?? message.type)}`))
      }, options.timeoutMs ?? 30_000)
      this.pending.set(id, {
        resolve: (response) => {
          options.onResponse?.(response)
          resolve(response)
        },
        reject,
        timer,
      })
      try {
        this.send({ ...message, id })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  fail(error: Error): void {
    this.rejectFailure(error)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    void this.stop()
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask
    this.stopped = true
    this.options.signal.removeEventListener('abort', this.abortListener)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Runtime process is closed'))
    }
    this.pending.clear()
    this.stopTask = (async () => {
      if (this.exited) return
      const kill = (signal: NodeJS.Signals): void => {
        try {
          if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, signal)
          else this.child.kill(signal)
        } catch {
          /* Process already exited. */
        }
      }
      this.child.stdin.end()
      kill('SIGTERM')
      const timer = setTimeout(() => kill('SIGKILL'), 1500)
      await this.closed
      clearTimeout(timer)
    })()
    return this.stopTask
  }
}
