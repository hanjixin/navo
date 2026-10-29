import { randomUUID } from 'node:crypto'
import type { DesktopConsentRequest } from '../../shared/types'
import type { DesktopApp } from './snapshot'

type Pending = { request: DesktopConsentRequest; resolve: () => void; reject: (error: Error) => void }

/** Serializes approval UI while keeping grants scoped to the requesting conversation. */
export class DesktopConsent {
  private sessions = new Map<string, Set<string>>()
  private queue: Pending[] = []
  private active: Pending | undefined

  constructor(private readonly options: { blocked: () => string[]; publish: (request: DesktopConsentRequest | null) => void }) {}

  allowed(threadId: string, bundleId: string): boolean {
    return !this.isBlocked(bundleId) && !!this.sessions.get(threadId)?.has(bundleId)
  }

  current(): DesktopConsentRequest | null {
    return this.active ? { ...this.active.request } : null
  }

  request(threadId: string, app: DesktopApp): Promise<void> {
    if (this.isBlocked(app.bundleId)) return Promise.reject(new Error(`已禁止控制应用 ${app.name}`))
    if (this.sessions.get(threadId)?.has(app.bundleId)) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ request: { id: randomUUID(), threadId, app: app.name, bundleId: app.bundleId }, resolve, reject })
      this.advance()
    })
  }

  resolve(id: string, decision: 'session' | 'once' | 'deny'): void {
    const pending = this.active
    if (!pending || pending.request.id !== id) return
    this.active = undefined
    const { threadId, bundleId } = pending.request
    if (decision === 'deny' || this.isBlocked(bundleId)) pending.reject(new Error('桌面操作授权被拒绝'))
    else if (decision === 'session' || decision === 'once') {
      if (decision === 'session') {
        let grants = this.sessions.get(threadId)
        if (!grants) this.sessions.set(threadId, (grants = new Set()))
        grants.add(bundleId)
      }
      pending.resolve()
    } else pending.reject(new Error('无效的桌面授权决定'))
    this.options.publish(null)
    this.advance()
  }

  cancel(threadId?: string): void {
    const matches = (p: Pending) => threadId === undefined || p.request.threadId === threadId
    const cancelled = this.queue.filter(matches)
    this.queue = this.queue.filter((p) => !matches(p))
    if (this.active && matches(this.active)) {
      cancelled.push(this.active)
      this.active = undefined
      this.options.publish(null)
    }
    for (const pending of cancelled) pending.reject(new Error('桌面操作授权已取消'))
    this.advance()
  }

  forget(threadId: string): void {
    this.sessions.delete(threadId)
    this.cancel(threadId)
  }

  private isBlocked(bundleId: string): boolean {
    return this.options.blocked().some((id) => id.toLowerCase() === bundleId.toLowerCase())
  }

  private advance(): void {
    if (this.active) return
    while (this.queue.length) {
      const next = this.queue.shift()!
      const { bundleId, threadId } = next.request
      if (this.isBlocked(bundleId)) next.reject(new Error('已禁止控制该应用'))
      else if (this.sessions.get(threadId)?.has(bundleId)) next.resolve()
      else {
        this.active = next
        this.options.publish(next.request)
        return
      }
    }
  }
}
