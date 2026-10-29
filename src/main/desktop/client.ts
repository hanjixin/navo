import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

export class DesktopTransportError extends Error {}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
export interface DesktopTransport {
  request<T>(cmd: string, args?: Record<string, unknown>): Promise<T>
  close(): void
}

/** Mutations are never replayed after a crash or timeout: their outcome may be unknown. */
export class DesktopClient implements DesktopTransport {
  private child: ChildProcessWithoutNullStreams | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1

  constructor(
    private readonly options: {
      executable: string
      args?: string[]
      timeout?: number
      onInput: (reason: string) => void
      onFailure: () => void
    },
  ) {}

  request<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++
    const message = `${JSON.stringify({ id, cmd, args })}\n`
    const child = this.start()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(child, '桌面控制服务超时，操作结果未知；请先重新获取快照'), this.options.timeout ?? 10_000)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      child.stdin.write(message, (err) => {
        if (err) this.fail(child, `桌面控制服务写入失败：${err.message}`)
      })
    })
  }

  close(): void {
    const child = this.child
    if (child) this.fail(child, '桌面控制已停止', false)
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child
    const child = spawn(this.options.executable, this.options.args ?? [], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      if (this.child !== child) return
      try {
        const msg = JSON.parse(line)
        if (msg?.event === 'user_input') {
          this.options.onInput(String(msg.reason ?? 'user'))
          return
        }
        const p = this.pending.get(msg?.id)
        if (!p) return
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.ok === true) p.resolve(msg.result)
        else p.reject(new Error(typeof msg.error === 'string' ? msg.error : '桌面操作失败'))
      } catch {
        this.fail(child, '桌面控制服务返回了无效响应')
      }
    })
    // Drain stderr; diagnostics must not block the helper or leak desktop contents into logs.
    child.stderr.resume()
    child.on('error', (err) => this.fail(child, `无法启动桌面控制服务：${err.message}`))
    child.on('exit', () => this.fail(child, '桌面控制服务已退出，请重新获取快照'))
    child.stdin.on('error', () => this.fail(child, '桌面控制服务连接已关闭'))
    return child
  }

  private fail(child: ChildProcessWithoutNullStreams, message: string, notify = true): void {
    if (this.child !== child) return
    this.child = null
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new DesktopTransportError(message))
    }
    this.pending.clear()
    child.kill('SIGTERM')
    // A hung main run loop may not process SIGTERM; never leave an old helper injecting input.
    const kill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 1000)
    kill.unref()
    if (notify) this.options.onFailure()
  }
}
