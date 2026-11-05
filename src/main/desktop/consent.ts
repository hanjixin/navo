import { randomUUID } from 'node:crypto'
import type { DesktopConsentDecision, DesktopConsentRequest } from '../../shared/types'
import type { DesktopGrant } from '../../shared/control-state'
import type { DesktopApp } from './snapshot'
import { desktopAppKey } from './platform'

type Pending = { request: DesktopConsentRequest; resolve: () => void; reject: (error: Error) => void }

/** Grants live only in this process; task grants survive approval resumes, never a new task. */
export class DesktopConsent {
  private grantsById = new Map<string, DesktopGrant>()
  private executions = new Map<string, string>()
  private queue: Pending[] = []
  private active: Pending | undefined

  constructor(
    private readonly options: { blocked: () => string[]; publish: (request: DesktopConsentRequest | null) => void; revoked?: (threadId: string) => void },
  ) {}

  beginExecution(threadId: string, executionId: string): void {
    const prior = this.executions.get(threadId)
    if (prior && prior !== executionId) this.endExecution(threadId, prior)
    this.executions.set(threadId, executionId)
  }

  endExecution(threadId: string, executionId: string): void {
    if (this.executions.get(threadId) !== executionId) return
    this.cancel(threadId)
    this.executions.delete(threadId)
    for (const [id, grant] of this.grantsById)
      if (grant.threadId === threadId && grant.scope === 'execution' && grant.executionId === executionId) this.grantsById.delete(id)
    this.options.publish(this.current())
  }

  grants(): DesktopGrant[] {
    return [...this.grantsById.values()].map((grant) => ({ ...grant }))
  }

  revoke(id: string): void {
    const grant = this.grantsById.get(id)
    if (!grant) throw new Error('授权已失效，请刷新后重试')
    this.grantsById.delete(id)
    this.cancel(grant.threadId)
    this.options.revoked?.(grant.threadId)
    this.options.publish(this.current())
  }

  allowed(threadId: string, bundleId: string): boolean {
    const executionId = this.executions.get(threadId)
    return (
      !this.isBlocked(bundleId) &&
      this.grants().some(
        (grant) =>
          grant.threadId === threadId &&
          desktopAppKey(grant.bundleId) === desktopAppKey(bundleId) &&
          (grant.scope === 'session' || grant.executionId === executionId),
      )
    )
  }

  current(): DesktopConsentRequest | null {
    return this.active ? { ...this.active.request } : null
  }
  pending(): DesktopConsentRequest[] {
    return [...(this.active ? [this.active] : []), ...this.queue].map((pending) => ({ ...pending.request }))
  }

  request(threadId: string, app: DesktopApp): Promise<void> {
    if (this.isBlocked(app.bundleId)) return Promise.reject(new Error(`已禁止控制应用 ${app.name}`))
    if (this.allowed(threadId, app.bundleId)) return Promise.resolve()
    let executionId = this.executions.get(threadId)
    if (!executionId) {
      executionId = randomUUID()
      this.beginExecution(threadId, executionId)
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ request: { id: randomUUID(), threadId, executionId, createdAt: Date.now(), app: app.name, bundleId: app.bundleId }, resolve, reject })
      this.advance()
      this.options.publish(this.current())
    })
  }

  resolve(id: string, decision: DesktopConsentDecision): void {
    const pending = this.active
    if (!pending || pending.request.id !== id || this.executions.get(pending.request.threadId) !== pending.request.executionId)
      throw new Error('授权请求已失效，请刷新后重试')
    this.active = undefined
    const { threadId, bundleId, executionId, app } = pending.request
    if (decision === 'deny' || this.isBlocked(bundleId)) pending.reject(new Error('桌面操作授权被拒绝'))
    else if (decision === 'session' || decision === 'execution' || decision === 'once') {
      if (decision !== 'once') {
        const grant: DesktopGrant = {
          id: randomUUID(),
          threadId,
          bundleId,
          app,
          executionId: decision === 'execution' ? executionId : null,
          scope: decision,
          createdAt: Date.now(),
        }
        this.grantsById.set(grant.id, grant)
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
    }
    for (const pending of cancelled) pending.reject(new Error('桌面操作授权已取消'))
    this.options.publish(this.current())
    this.advance()
  }

  forget(threadId: string): void {
    for (const [id, grant] of this.grantsById) if (grant.threadId === threadId) this.grantsById.delete(id)
    this.executions.delete(threadId)
    this.cancel(threadId)
  }

  clear(): void {
    this.grantsById.clear()
    this.executions.clear()
    this.cancel()
  }

  private isBlocked(bundleId: string): boolean {
    return this.options.blocked().some((id) => desktopAppKey(id) === desktopAppKey(bundleId))
  }

  private advance(): void {
    if (this.active) return
    while (this.queue.length) {
      const next = this.queue.shift()!
      const { bundleId, threadId, executionId } = next.request
      if (this.executions.get(threadId) !== executionId) next.reject(new Error('授权请求已失效，请刷新后重试'))
      else if (this.isBlocked(bundleId)) next.reject(new Error('已禁止控制该应用'))
      else if (this.allowed(threadId, bundleId)) next.resolve()
      else {
        this.active = next
        this.options.publish(next.request)
        return
      }
    }
  }
}
