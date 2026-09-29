import { ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import type { Decision, PendingInterrupt } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { toolMeta } from './tool-meta'

export function InterruptCard({ interrupt, onDecide }: { interrupt: PendingInterrupt; onDecide: (d: Decision[], alwaysAllow?: string[]) => Promise<void> }) {
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const reqs = interrupt.actionRequests

  const decideAll = async (make: (i: number) => Decision, alwaysAllow?: string[]) => {
    setPending(true)
    try {
      await onDecide(
        reqs.map((_, i) => make(i)),
        alwaysAllow,
      )
    } finally {
      setPending(false)
    }
  }

  const saveEdit = async () => {
    try {
      const args = JSON.parse(draft) as Record<string, unknown>
      setError(null)
      await decideAll((i) => (i === editing ? { type: 'edit', editedAction: { name: reqs[i].name, args } } : { type: 'approve' }))
    } catch {
      setError('参数不是合法的 JSON')
    }
  }

  return (
    <div className="animate-fade-in rounded-lg border border-l-2 border-border border-l-warning bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <ShieldAlert className="size-4 stroke-[1.75] text-warning" />
        <span className="text-sm font-medium">需要你的确认</span>
      </div>
      <div className="grid gap-2">
        {reqs.map((r, i) => (
          <div key={i} className="rounded-md bg-muted px-3 py-2">
            <div className="text-xs font-medium">{toolMeta(r.name).label}</div>
            {editing === i ? (
              <>
                <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={6} className="mt-2 font-mono text-xs" />
                {error ? <p className="mt-1 text-xs text-danger">{error}</p> : null}
              </>
            ) : (
              <pre className="selectable mt-1 max-h-40 overflow-auto font-mono text-[11.5px] [overflow-wrap:anywhere] whitespace-pre-wrap text-muted-foreground">
                {JSON.stringify(r.args, null, 2)}
              </pre>
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2">
        {editing != null ? (
          <>
            <Button variant="primary" size="sm" loading={pending} onClick={saveEdit}>
              使用修改后的参数
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
              取消
            </Button>
          </>
        ) : (
          <>
            <Button variant="primary" size="sm" loading={pending} onClick={() => decideAll(() => ({ type: 'approve' }))}>
              批准执行
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() => decideAll(() => ({ type: 'approve' }), [...new Set(reqs.map((r) => r.name))])}
              title="本会话中不再询问这些操作"
            >
              本会话始终允许
            </Button>
            <Button variant="secondary" size="sm" disabled={pending} onClick={() => decideAll(() => ({ type: 'reject', message: '用户拒绝了该操作' }))}>
              拒绝
            </Button>
            {interrupt.allowedDecisions[0]?.includes('edit') && reqs.length === 1 ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => {
                  setDraft(JSON.stringify(reqs[0].args, null, 2))
                  setEditing(0)
                }}
              >
                修改参数
              </Button>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
