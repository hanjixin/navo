import { Workflow } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import type { FlowDraft } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/input'
import { ErrorState, Skeleton } from '@/components/ui/states'
import { call } from '@/lib/ipc'
import { errorMessage } from '@/lib/utils'
import { useFlowDialog } from '@/stores/flows'

const STEP_TEXT: Record<string, (s: FlowDraft['steps'][number]) => string> = {
  navigate: (s) => `打开 ${s.url}`,
  click: (s) => `点击「${s.label || s.selectors?.[0] || ''}」`,
  type: (s) => `在「${s.label || s.selectors?.[0] || ''}」输入 ${s.value ?? ''}`,
  select: (s) => `在「${s.label || s.selectors?.[0] || ''}」选择 ${s.value ?? ''}`,
  press: (s) => `按 ${s.key ?? 'Enter'}`,
}

/** "Keep as a fixed flow": the steps the agent took, a name, and which values are parameters. */
export function FlowDialog() {
  const threadId = useFlowDialog((s) => s.threadId)
  const close = useFlowDialog((s) => s.close)
  const navigate = useNavigate()
  const [draft, setDraft] = useState<FlowDraft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDraft(null)
    setError(null)
    if (threadId) call('flows.draft', threadId).then(setDraft, (e) => setError(errorMessage(e)))
  }, [threadId])

  if (!threadId) return null
  const save = async () => {
    if (!draft) return
    setSaving(true)
    try {
      const m = await call('flows.save', draft)
      close()
      toast.success(`已保存为固定流程「${m.name}」`, {
        description: '以后 Agent 遇到同样的事会直接回放；也可以在录制宏页面回放，或设为定时任务',
        action: { label: '查看', onClick: () => navigate('/macros') },
      })
    } catch (e) {
      toast.error('保存失败', { description: errorMessage(e) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent
        title="固化为固定流程"
        description="把这次的浏览器操作保存下来。以后直接按步骤回放，不再调用模型；页面改版导致某一步失效时，再由 Agent 接手并更新流程。"
        className="w-[min(720px,calc(100vw-48px))]"
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              取消
            </Button>
            <Button variant="primary" disabled={!draft || saving || !draft.name.trim()} onClick={() => void save()}>
              <Workflow />
              保存流程
            </Button>
          </>
        }
      >
        {error ? (
          <ErrorState error={error} />
        ) : !draft ? (
          <div className="grid gap-3">
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
            <Skeleton className="h-40" />
          </div>
        ) : (
          <div className="grid gap-4">
            <Field label="名称">
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={40} />
            </Field>
            <Field label="说明" hint="Agent 根据它判断什么时候用这个流程">
              <Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
            </Field>
            <div>
              <div className="mb-1.5 text-sm font-medium">参数</div>
              {draft.params.length ? (
                <div className="grid gap-1.5">
                  {draft.params.map((p, i) => (
                    <div key={p.name} data-testid="flow-param" className="grid grid-cols-[140px_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 text-sm">
                      <code className="truncate font-mono text-xs">{`{{${p.name}}}`}</code>
                      <Input
                        value={p.description ?? ''}
                        placeholder="说明"
                        onChange={(e) => setDraft({ ...draft, params: draft.params.map((x, k) => (k === i ? { ...x, description: e.target.value } : x)) })}
                        className="h-8 text-xs"
                      />
                      <Input
                        value={p.default ?? ''}
                        // a password is not stored with the flow: it is filled in each time it runs
                        disabled={p.name === 'password'}
                        placeholder={p.name === 'password' ? '运行时填写' : '默认值'}
                        onChange={(e) => setDraft({ ...draft, params: draft.params.map((x, k) => (k === i ? { ...x, default: e.target.value } : x)) })}
                        className="h-8 text-xs"
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">没有每次会变的值，每次都按相同内容回放。</p>
              )}
            </div>
            <div>
              <div className="mb-1.5 text-sm font-medium">步骤</div>
              <ol className="max-h-56 overflow-y-auto rounded-md border border-border bg-muted/40 px-4 py-2 text-xs leading-relaxed">
                {draft.startUrl ? <li className="text-muted-foreground">起始页面：{draft.startUrl}</li> : null}
                {draft.steps.map((s, i) => (
                  <li key={s.id} data-testid="flow-step">
                    {i + 1}. {(STEP_TEXT[s.type] ?? (() => s.type))(s)}
                  </li>
                ))}
              </ol>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
