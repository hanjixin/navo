import type { DesktopStatus } from '@shared/types'
import type { DesktopStop, DesktopStopReason } from '@shared/control-state'
import { randomUUID } from 'node:crypto'
import type { DesktopConsent } from './consent'
import { DesktopTransportError, type DesktopTransport } from './client'
import {
  DesktopSnapshot,
  screenshotPoint,
  copyWindow,
  sameWindow,
  treeContainsText,
  type AXTree,
  type DesktopApp,
  type DesktopWindow,
  type Screenshot,
} from './snapshot'
import { desktopAppKey } from './platform'

type Session = {
  executionId: string
  app?: DesktopApp
  snapshot: DesktopSnapshot
  image?: Screenshot
  window?: DesktopWindow
  stopped: boolean
  failures: number
  outcomeUnknown: boolean
}
export type DesktopLocation = { ref?: string; x?: number; y?: number }

/** One physical desktop has one owner. Every await is followed by a cancellation check. */
export class DesktopController {
  private sessions = new Map<string, Session>()
  private owner: string | null = null
  private busy = false
  private watching = false
  private active: DesktopStatus['active'] = null
  private permissions = { accessibility: false, screenRecording: false }
  private helper: DesktopStatus['helper'] = 'missing'
  private releasing: Promise<void> | null = null
  private checkedAt: number | null = null
  private checking = false
  private lastStop: DesktopStop | null = null
  private refreshing: Promise<void> | null = null

  constructor(
    private readonly options: {
      client: DesktopTransport
      consent: DesktopConsent
      enabled: () => boolean
      supported: () => boolean
      platform?: string
      available: () => boolean
      blocked: () => string[]
      changed: (active: DesktopStatus['active']) => void
      abort: (threadId: string) => void
    },
  ) {}

  status(): DesktopStatus {
    const platform = this.options.platform ?? process.platform
    return {
      platform: platform === 'darwin' || platform === 'win32' ? platform : 'unsupported',
      supported: this.options.supported(),
      ...this.permissions,
      helper: this.options.available() ? this.helper : 'missing',
      active: this.active,
      checkedAt: this.checkedAt,
      checking: this.checking,
      lastStop: this.lastStop,
    }
  }

  async refresh(request?: 'accessibility' | 'screenRecording'): Promise<void> {
    if (this.refreshing) {
      await this.refreshing
      if (!request) return
    }
    this.checking = true
    this.options.changed(this.active)
    this.refreshing = (async () => {
      try {
        if (!this.options.supported() || !this.options.available()) return
        this.permissions = await this.options.client.request('permissions', request ? { request } : {})
        this.helper = 'ok'
      } catch {
        this.helper = 'failed'
      } finally {
        this.checkedAt = Date.now()
        this.checking = false
        this.options.changed(this.active)
      }
    })()
    try {
      await this.refreshing
    } finally {
      this.refreshing = null
    }
  }

  beginRun(threadId: string, executionId: string = randomUUID()): void {
    this.options.consent.beginExecution(threadId, executionId)
    this.sessions.set(threadId, { executionId, snapshot: new DesktopSnapshot(), stopped: false, failures: 0, outcomeUnknown: false })
  }

  endExecution(threadId: string, executionId: string): void {
    this.options.consent.endExecution(threadId, executionId)
  }

  async endRun(threadId: string): Promise<void> {
    this.options.consent.cancel(threadId)
    const s = this.sessions.get(threadId)
    if (s) s.stopped = true
    if (this.owner === threadId) await this.release()
    if (this.sessions.get(threadId) === s) this.sessions.delete(threadId)
  }

  forget(threadId: string): void {
    this.options.consent.forget(threadId)
    void this.endRun(threadId)
  }

  stop(threadId = this.owner, notify = true, reason: DesktopStopReason = 'user_stop'): void {
    if (!threadId || !this.sessions.get(threadId)?.stopped) this.lastStop = { reason, threadId, at: Date.now() }
    this.options.changed(this.active)
    if (!threadId) {
      this.options.consent.cancel()
      return
    }
    const s = this.sessions.get(threadId)
    if (s) s.stopped = true
    this.options.consent.cancel(threadId)
    if (this.owner === threadId) void this.release()
    if (notify) this.options.abort(threadId)
  }

  /** A restart invalidates all native element IDs and captured coordinate maps. */
  failed(): void {
    this.helper = 'failed'
    if (this.owner) this.stop(this.owner, true, 'service_failure')
    else {
      this.lastStop = { reason: 'service_failure', threadId: null, at: Date.now() }
      this.options.changed(this.active)
    }
    this.watching = false
    for (const s of this.sessions.values()) {
      s.snapshot.clear()
      s.image = undefined
      s.window = undefined
    }
    this.options.changed(this.active)
  }

  shutdown(): void {
    if (this.owner) this.stop(this.owner, true)
    for (const s of this.sessions.values()) s.stopped = true
    this.options.consent.clear()
    this.options.client.close()
  }

  apps(threadId: string): Promise<string> {
    return this.operation(
      threadId,
      false,
      async (s) => {
        const apps = await this.native<DesktopApp[]>(threadId, s, 'apps')
        return JSON.stringify(
          apps.filter((a) => !this.blocked(a.bundleId)),
          null,
          2,
        )
      },
      false,
    )
  }

  activate(threadId: string, app: string): Promise<string> {
    return this.operation(threadId, false, async (s) => {
      await this.prepare(threadId, s, app)
      return this.capture(threadId, s)
    })
  }

  snapshot(threadId: string, app?: string): Promise<string> {
    return this.operation(threadId, false, async (s) => {
      await this.prepare(threadId, s, app)
      return this.capture(threadId, s)
    })
  }

  screenshot(threadId: string, app?: string): Promise<Screenshot> {
    return this.operation(threadId, true, async (s) => {
      await this.prepare(threadId, s, app)
      const image = await this.native<Screenshot>(threadId, s, 'screenshot', { bundleId: s.app!.bundleId })
      const window = this.requireWindow(image.window, s)
      if (
        image.bounds.x !== window.bounds.x ||
        image.bounds.y !== window.bounds.y ||
        image.bounds.width !== window.bounds.width ||
        image.bounds.height !== window.bounds.height
      )
        throw new Error('截图窗口位置不一致，请重新截图')
      s.image = { ...image, bounds: { ...image.bounds }, window }
      s.window = copyWindow(window)
      return image
    })
  }

  action(threadId: string, cmd: 'click' | 'type' | 'key' | 'scroll', args: Record<string, unknown> & DesktopLocation): Promise<string> {
    const session = this.sessions.get(threadId)
    return this.operation(threadId, false, async (s) => {
      if (!s.app) throw new Error('请先调用 desktop_activate 或 desktop_snapshot 选择应用')
      if (s.outcomeUnknown) throw new Error('上一次桌面操作结果未知，请先由用户确认状态后重新开始')
      // Resolve refs and image coordinates before reactivation; stale captures must never select a new target.
      await this.location(threadId, s, args)
      await this.prepare(threadId, s)
      const location = await this.location(threadId, s, args)
      const window = this.requireWindow(args.ref ? s.snapshot.get(args.ref).window : 'x' in location ? s.image?.window : s.window, s)
      if ('x' in location) {
        const at = await this.native<DesktopApp | null>(threadId, s, 'window_at', location)
        if (!at || at.bundleId !== s.app.bundleId) {
          this.invalidate(s)
          throw new Error('坐标不属于当前授权应用，请重新截图')
        }
        if (!sameWindow(window, at.window)) {
          this.invalidate(s)
          throw new Error('截图窗口已切换或移动，请重新截图')
        }
      }
      // Consume handles before injection: an error can leave the mutation outcome unknown.
      this.invalidate(s)
      await this.native(threadId, s, cmd, { ...args, ...location, expectedWindow: window, bundleId: s.app.bundleId })
      await new Promise((resolve) => setTimeout(resolve, 150))
      this.check(threadId, s)
      return this.capture(threadId, s, true)
    }).catch((error) => {
      if (error instanceof DesktopTransportError && session) {
        session.outcomeUnknown = true
        this.invalidate(session)
        throw new Error('桌面操作结果未知，已停止自动重试；请重新获取快照并由用户确认当前状态', { cause: error })
      }
      throw error
    })
  }

  waitFor(threadId: string, text: string, timeout: number): Promise<string> {
    return this.operation(threadId, false, async (s) => {
      await this.prepare(threadId, s)
      const until = Date.now() + Math.min(Math.max(timeout, 0), 30_000)
      do {
        const tree = await this.observe(threadId, s)
        const snapshot = s.snapshot.update(tree)
        if (treeContainsText(tree, text)) return snapshot
        if (Date.now() >= until) break
        await new Promise((resolve) => setTimeout(resolve, 250))
        this.check(threadId, s)
      } while (Date.now() <= until)
      throw new Error(`等待超时：窗口中未出现「${text}」`)
    })
  }

  private async operation<T>(threadId: string, screen: boolean, run: (s: Session) => Promise<T>, access = true): Promise<T> {
    let s = this.sessions.get(threadId)
    if (!s) {
      this.beginRun(threadId)
      s = this.sessions.get(threadId)!
    }
    this.check(threadId, s)
    if (this.busy || this.releasing || (this.owner && this.owner !== threadId)) throw new Error('另一个桌面操作正在进行，请稍后重试')
    this.owner = threadId
    this.busy = true
    try {
      this.permissions = await this.native(threadId, s, 'permissions')
      this.checkedAt = Date.now()
      if ((access && !this.permissions.accessibility) || (screen && !this.permissions.screenRecording)) {
        this.stop(threadId, false, 'permission_missing')
        if (this.options.platform === 'win32') throw new Error('当前 Windows 桌面不可操作，请解锁电脑并关闭系统安全提示后重试')
        throw new Error(
          access && !this.permissions.accessibility ? '缺少辅助功能权限，请到 设置 → 电脑操作 授权' : '缺少屏幕录制权限，请到 设置 → 电脑操作 授权',
        )
      }
      const result = await run(s)
      s.failures = 0
      return result
    } catch (err) {
      if (err instanceof DesktopTransportError && ++s.failures >= 3) {
        this.stop(threadId, false, 'service_failure')
        throw new Error('桌面控制服务连续失败三次，本次运行已暂停桌面工具', { cause: err })
      }
      throw err
    } finally {
      this.busy = false
      if (!this.active && this.owner === threadId) this.owner = null
    }
  }

  private check(threadId: string, s: Session): void {
    if (!this.options.enabled()) throw new Error('桌面控制尚未开启，请到 设置 → 电脑操作 开启')
    if (!this.options.supported()) throw new Error('桌面控制需要 macOS 14+ 或 Windows 10/11')
    if (!this.options.available()) throw new Error('桌面控制服务缺失，请重新构建或安装 Navo')
    if (s.stopped || this.sessions.get(threadId) !== s)
      throw new Error(
        this.lastStop?.reason === 'permission_missing'
          ? '桌面操作因权限缺失已暂停，请检查系统权限'
          : this.lastStop?.reason === 'service_failure'
            ? '桌面操作因服务故障已暂停，请检查服务状态'
            : this.lastStop?.reason === 'authorization_revoked'
              ? '桌面操作授权已撤销，请重新授权'
              : '桌面操作已被用户中止，请等待用户继续',
      )
  }

  private blocked(bundleId: string): boolean {
    return this.options.blocked().some((id) => desktopAppKey(id) === desktopAppKey(bundleId))
  }

  private async native<T>(threadId: string, s: Session, cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    this.check(threadId, s)
    if (typeof args.bundleId === 'string' && this.blocked(args.bundleId)) throw new Error('已禁止控制该应用')
    const result = await this.options.client.request<T>(cmd, args)
    this.check(threadId, s)
    this.helper = 'ok'
    return result
  }

  private async prepare(threadId: string, s: Session, name?: string): Promise<void> {
    const app = name
      ? await this.native<DesktopApp>(threadId, s, 'resolve', { app: name })
      : (s.app ?? (await this.native<DesktopApp>(threadId, s, 'frontmost')))
    if (!app?.bundleId) throw new Error('未找到可操作的应用，请先调用 desktop_activate')
    if (this.blocked(app.bundleId)) throw new Error(`已禁止控制应用 ${app.name}`)
    // Let the user reach the approval UI without treating that mouse movement as an emergency stop.
    if (this.watching && !this.options.consent.allowed(threadId, app.bundleId)) {
      await this.native(threadId, s, 'watch_user_input', { enabled: false })
      this.watching = false
    }
    await this.options.consent.request(threadId, app)
    this.check(threadId, s)
    if (this.blocked(app.bundleId)) throw new Error(`已禁止控制应用 ${app.name}`)
    if (s.app?.bundleId !== app.bundleId) {
      s.snapshot.clear()
      s.image = undefined
      s.window = undefined
    }
    this.active = { threadId, bundleId: app.bundleId, app: app.name }
    this.options.changed(this.active)
    if (!this.watching) {
      await this.native(threadId, s, 'watch_user_input', { enabled: true })
      this.watching = true
    }
    s.app = await this.native<DesktopApp>(threadId, s, 'activate', { bundleId: app.bundleId })
  }

  private async capture(threadId: string, s: Session, diff = false): Promise<string> {
    const tree = await this.observe(threadId, s)
    return diff ? s.snapshot.diff(tree) : s.snapshot.update(tree)
  }

  private async observe(threadId: string, s: Session): Promise<AXTree> {
    const tree = await this.native<AXTree>(threadId, s, 'ax_tree', { bundleId: s.app!.bundleId })
    s.window = copyWindow(tree.window)
    return tree
  }

  private requireWindow(window: DesktopWindow | undefined, s: Session): DesktopWindow {
    const observed = copyWindow(window)
    if (!observed || observed.pid !== s.app?.pid) throw new Error('无法确认目标窗口，请重新获取快照或截图')
    return observed
  }

  private invalidate(s: Session): void {
    s.image = undefined
    s.snapshot.clear()
    s.window = undefined
  }

  private async location(threadId: string, s: Session, args: DesktopLocation): Promise<Record<string, unknown>> {
    if (args.ref && (args.x !== undefined || args.y !== undefined)) throw new Error('元素引用和截图坐标只能选择一种')
    if (args.ref) {
      const ref = s.snapshot.get(args.ref)
      if (ref.bundleId !== s.app!.bundleId) throw new Error('元素不属于当前应用，请重新获取快照')
      return { ref: ref.id }
    }
    if (args.x !== undefined || args.y !== undefined) {
      if (!s.image || args.x === undefined || args.y === undefined) throw new Error('请先获取 desktop_screenshot，再使用截图内的 x、y 坐标')
      this.check(threadId, s)
      return screenshotPoint(s.image, args.x, args.y)
    }
    return {}
  }

  private release(): Promise<void> {
    if (this.releasing) return this.releasing
    const owner = this.owner
    this.active = null
    this.watching = false
    this.options.changed(null)
    // Keep ownership until native release completes so another conversation cannot race it.
    this.releasing = this.options.client
      .request('release')
      .then(() => undefined)
      .catch(() => this.options.client.close())
      .finally(() => {
        if (this.owner === owner) this.owner = null
        this.releasing = null
      })
    return this.releasing
  }
}
