export interface RuntimeWatchdogOptions {
  firstTokenMs?: number
  idleMs?: number
  onTimeout: (message: string) => void
}

/** Detects a live process that stopped producing protocol activity. */
export class RuntimeWatchdog {
  private first: ReturnType<typeof setTimeout> | undefined
  private idle: ReturnType<typeof setTimeout> | undefined
  private started = false
  private paused = false
  private readonly firstTokenMs: number
  private readonly idleMs: number
  constructor(private readonly options: RuntimeWatchdogOptions) {
    this.firstTokenMs = options.firstTokenMs ?? Number(process.env.NAVO_RUNTIME_FIRST_TOKEN_MS ?? 120_000)
    this.idleMs = options.idleMs ?? Number(process.env.NAVO_RUNTIME_IDLE_MS ?? 180_000)
  }
  start(): void {
    this.started = true
    this.resetFirst()
  }
  activity(): void {
    if (!this.started || this.paused) return
    if (this.first) {
      clearTimeout(this.first)
      this.first = undefined
    }
    this.resetIdle()
  }
  pause(): void {
    this.paused = true
    if (this.first) clearTimeout(this.first)
    if (this.idle) clearTimeout(this.idle)
    this.first = undefined
    this.idle = undefined
  }
  resume(): void {
    if (!this.started) return
    this.paused = false
    this.resetIdle()
  }
  stop(): void {
    if (this.first) clearTimeout(this.first)
    if (this.idle) clearTimeout(this.idle)
    this.first = undefined
    this.idle = undefined
    this.started = false
  }
  private resetFirst(): void {
    if (!Number.isFinite(this.firstTokenMs) || this.firstTokenMs <= 0) return
    this.first = setTimeout(() => this.options.onTimeout('Runtime did not produce a first response before the timeout'), this.firstTokenMs)
  }
  private resetIdle(): void {
    if (!Number.isFinite(this.idleMs) || this.idleMs <= 0) return
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => this.options.onTimeout('Runtime stopped producing responses before the idle timeout'), this.idleMs)
  }
}
