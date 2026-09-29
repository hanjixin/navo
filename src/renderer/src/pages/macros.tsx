import { ArrowDown, ArrowUp, Bot, Circle, Clapperboard, Play, Plus, Save, Sparkles, Square, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import type { Macro, MacroRunResult, MacroStep, MacroStepType } from '@shared/types'
import { PageHeader } from '@/components/layout/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, Input } from '@/components/ui/input'
import { AsyncView, EmptyState, ListSkeleton } from '@/components/ui/states'
import { Switch } from '@/components/ui/switch'
import { useAsync } from '@/hooks/use-async'
import { call } from '@/lib/ipc'
import { cn, errorMessage, timeAgo } from '@/lib/utils'
import { useBrowser } from '@/stores/browser'
import { useChat } from '@/stores/chat'

const STEP_LABEL: Record<MacroStepType, string> = {
  navigate: '打开',
  click: '点击',
  type: '输入',
  select: '选择',
  press: '按键',
  wait: '等待',
  scroll: '滚动',
  extract: '提取',
}

function StepRow({
  step,
  index,
  total,
  failed,
  onChange,
  onMove,
  onDelete,
}: {
  step: MacroStep
  index: number
  total: number
  failed: boolean
  onChange: (s: MacroStep) => void
  onMove: (dir: -1 | 1) => void
  onDelete: () => void
}) {
  const editableValue = step.type === 'type' || step.type === 'select' || step.type === 'wait' || step.type === 'scroll'
  return (
    <div className={cn('group flex items-start gap-3 rounded-md px-3 py-2.5 transition-colors', failed ? 'bg-danger-soft' : 'hover:bg-accent/50')}>
      <span
        className={cn(
          'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium',
          failed ? 'border-danger text-danger' : 'border-border text-muted-foreground',
        )}
      >
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Badge variant={step.type === 'navigate' ? 'primary' : 'neutral'}>{STEP_LABEL[step.type]}</Badge>
          <span className="truncate text-sm">{step.type === 'navigate' ? step.url : step.type === 'press' ? step.key : step.label}</span>
        </div>
        {step.selectors?.length ? <div className="mt-1 truncate font-mono text-[11px] text-subtle-foreground">{step.selectors[0]}</div> : null}
        {step.type === 'navigate' ? (
          <Input
            value={step.url ?? ''}
            onChange={(e) => onChange({ ...step, url: e.target.value, label: e.target.value })}
            className="mt-2 h-7 font-mono text-xs"
          />
        ) : null}
        {step.type === 'extract' ? (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Input value={step.label ?? ''} onChange={(e) => onChange({ ...step, label: e.target.value })} placeholder="结果名称" className="h-7 text-xs" />
            <Input
              value={step.selectors?.[0] ?? ''}
              onChange={(e) => onChange({ ...step, selectors: e.target.value ? [e.target.value] : [] })}
              placeholder="CSS 选择器（留空为全文）"
              className="h-7 font-mono text-xs"
            />
          </div>
        ) : null}
        {editableValue ? (
          <Input
            value={step.value ?? ''}
            onChange={(e) => onChange({ ...step, value: e.target.value })}
            placeholder={step.type === 'wait' ? '毫秒，或填写选择器等待元素' : step.type === 'scroll' ? '像素' : '值，可用 {{参数名}}'}
            className="mt-2 h-7 font-mono text-xs"
          />
        ) : null}
      </div>
      <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <Button variant="ghost" size="icon-sm" disabled={index === 0} onClick={() => onMove(-1)} aria-label="上移">
          <ArrowUp />
        </Button>
        <Button variant="ghost" size="icon-sm" disabled={index === total - 1} onClick={() => onMove(1)} aria-label="下移">
          <ArrowDown />
        </Button>
        <Button variant="ghost" size="icon-sm" className="hover:text-danger" onClick={onDelete} aria-label="删除步骤">
          <X />
        </Button>
      </div>
    </div>
  )
}

function MacroEditor({ macro, onSaved, onDeleted }: { macro: Macro; onSaved: (m: Macro) => void; onDeleted: () => void }) {
  const [m, setM] = useState(macro)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [runParams, setRunParams] = useState<Record<string, string> | null>(null)
  const [result, setResult] = useState<MacroRunResult | null>(null)
  const navigate = useNavigate()
  const newThread = useChat((s) => s.newThread)
  const send = useChat((s) => s.send)

  useEffect(() => {
    setM(macro)
    setDirty(false)
    setResult(null)
  }, [macro])

  const update = (patch: Partial<Macro>) => {
    setM((x) => ({ ...x, ...patch }))
    setDirty(true)
  }
  const setStep = (i: number, s: MacroStep) => update({ steps: m.steps.map((x, j) => (j === i ? s : x)) })
  const move = (i: number, dir: -1 | 1) => {
    const steps = [...m.steps]
    ;[steps[i], steps[i + dir]] = [steps[i + dir], steps[i]]
    update({ steps })
  }
  const addStep = (type: MacroStepType) =>
    update({
      steps: [
        ...m.steps,
        {
          id: `s${Date.now().toString(36)}`,
          type,
          value: type === 'wait' ? '1000' : type === 'scroll' ? '600' : undefined,
          label: type === 'extract' ? `结果${m.steps.length + 1}` : undefined,
        },
      ],
    })

  const save = async () => {
    setSaving(true)
    try {
      const saved = await call('macros.save', m)
      setM(saved)
      setDirty(false)
      onSaved(saved)
      toast.success('宏已保存')
    } catch (e) {
      toast.error('保存失败', { description: errorMessage(e) })
    } finally {
      setSaving(false)
    }
  }

  const run = async (params: Record<string, string>) => {
    setRunParams(null)
    setRunning(true)
    setResult(null)
    try {
      if (dirty) await call('macros.save', m)
      const r = await call('macros.run', m.id, params)
      setResult(r)
      if (r.ok) toast.success('宏执行完成')
    } catch (e) {
      setResult({ ok: false, error: errorMessage(e), extracted: {} })
    } finally {
      setRunning(false)
    }
  }

  const handToAgent = async () => {
    if (!result || result.ok) return
    const step = m.steps[result.failedStep ?? 0]
    await newThread()
    navigate('/chat')
    void send(
      `我在运行录制宏「${m.name}」时，第 ${(result.failedStep ?? 0) + 1} 步失败：${result.error}\n失败步骤：${JSON.stringify(step)}\n\n全部步骤：\n${m.steps
        .map((s, i) => `${i + 1}. ${STEP_LABEL[s.type]} ${s.url ?? s.label ?? ''} ${s.value ? `值=${s.value}` : ''}`)
        .join('\n')}\n\n请基于当前浏览器页面，从失败的步骤开始继续完成剩余操作。`,
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-4 flex items-center gap-2">
        <Input value={m.name} onChange={(e) => update({ name: e.target.value })} className="h-9 max-w-md text-base font-semibold" />
        {dirty ? <span className="text-xs text-warning">未保存</span> : null}
        <div className="ml-auto flex gap-1.5">
          <Button variant="ghost" size="sm" className="hover:text-danger" onClick={async () => (await call('macros.delete', m.id), onDeleted())}>
            <Trash2 />
            删除
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              try {
                const name = await call('macros.toSkill', m.id)
                toast.success(`已生成 Skill：${name}`, { action: { label: '查看', onClick: () => navigate('/skills') } })
              } catch (e) {
                toast.error('生成失败', { description: errorMessage(e) })
              }
            }}
          >
            <Sparkles />
            生成 Skill
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={running}
            onClick={() => (m.params.length ? setRunParams(Object.fromEntries(m.params.map((p) => [p.name, p.default ?? '']))) : void run({}))}
          >
            {!running ? <Play /> : null}
            运行
          </Button>
          <Button variant="primary" size="sm" loading={saving} disabled={!dirty} onClick={save}>
            {!saving ? <Save /> : null}
            保存
          </Button>
        </div>
      </div>

      {result ? (
        result.ok ? (
          <div className="mb-4 animate-fade-in rounded-lg border border-l-2 border-border border-l-success bg-success-soft px-4 py-3 text-sm">
            <span className="font-medium">执行成功</span>
            {Object.keys(result.extracted).length ? (
              <pre className="selectable mt-2 max-h-40 overflow-auto font-mono text-xs whitespace-pre-wrap text-muted-foreground">
                {JSON.stringify(result.extracted, null, 2)}
              </pre>
            ) : null}
          </div>
        ) : (
          <div className="mb-4 flex animate-fade-in items-start gap-3 rounded-lg border border-l-2 border-border border-l-danger bg-danger-soft px-4 py-3">
            <div className="min-w-0 flex-1 text-sm">
              <span className="font-medium">第 {(result.failedStep ?? 0) + 1} 步执行失败</span>
              <p className="mt-0.5 text-xs break-words text-muted-foreground">{result.error}</p>
            </div>
            <Button variant="secondary" size="sm" onClick={handToAgent}>
              <Bot />
              交给 Agent 继续
            </Button>
          </div>
        )
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto @5xl:grid-cols-[1fr_280px] @5xl:overflow-visible">
        <Card className="flex min-h-0 flex-col">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <span className="text-sm font-medium">步骤 · {m.steps.length}</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm">
                  <Plus />
                  添加步骤
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {(['navigate', 'wait', 'scroll', 'extract'] as MacroStepType[]).map((t) => (
                  <DropdownMenuItem key={t} onSelect={() => addStep(t)}>
                    {STEP_LABEL[t]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {m.startUrl ? (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                起始页面 <span className="font-mono">{m.startUrl}</span>
              </div>
            ) : null}
            {m.steps.map((s, i) => (
              <StepRow
                key={s.id}
                step={s}
                index={i}
                total={m.steps.length}
                failed={result?.ok === false && result.failedStep === i}
                onChange={(x) => setStep(i, x)}
                onMove={(d) => move(i, d)}
                onDelete={() => update({ steps: m.steps.filter((_, j) => j !== i) })}
              />
            ))}
          </div>
        </Card>

        <div className="grid content-start gap-4 overflow-y-auto">
          <Card className="grid gap-4 p-4">
            <Field label="描述" hint="作为工具描述提供给 Agent">
              <Input value={m.description} onChange={(e) => update({ description: e.target.value })} placeholder="这个宏做什么" />
            </Field>
            <Field label="起始网址" hint="留空则在当前页运行">
              <Input value={m.startUrl ?? ''} onChange={(e) => update({ startUrl: e.target.value })} className="font-mono text-xs" />
            </Field>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>
                作为 Agent 工具
                <span className="block text-xs text-muted-foreground">对话中可直接调用</span>
              </span>
              <Switch checked={m.exposeAsTool} onCheckedChange={(v) => update({ exposeAsTool: v })} />
            </label>
          </Card>
          <Card className="p-4">
            <div className="text-sm font-medium">参数</div>
            <p className="mt-0.5 mb-3 text-xs text-muted-foreground">
              在步骤的值中使用 <code className="font-mono">{'{{name}}'}</code> 即可声明参数，保存后自动出现。
            </p>
            {m.params.length ? (
              <div className="grid gap-3">
                {m.params.map((p, i) => (
                  <div key={p.name} className="grid gap-1.5">
                    <code className="font-mono text-xs font-medium">{p.name}</code>
                    <Input
                      value={p.default ?? ''}
                      placeholder="默认值"
                      className="h-7 text-xs"
                      onChange={(e) => update({ params: m.params.map((x, j) => (j === i ? { ...x, default: e.target.value } : x)) })}
                    />
                    <Input
                      value={p.description ?? ''}
                      placeholder="说明（给 Agent 看）"
                      className="h-7 text-xs"
                      onChange={(e) => update({ params: m.params.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-subtle-foreground">暂无参数</p>
            )}
          </Card>
        </div>
      </div>

      <Dialog open={!!runParams} onOpenChange={(o) => !o && setRunParams(null)}>
        {runParams ? (
          <DialogContent
            title="运行参数"
            className="w-[440px]"
            footer={
              <>
                <Button variant="ghost" onClick={() => setRunParams(null)}>
                  取消
                </Button>
                <Button variant="primary" onClick={() => void run(runParams)}>
                  运行
                </Button>
              </>
            }
          >
            <div className="grid gap-3">
              {m.params.map((p) => (
                <Field key={p.name} label={p.name} hint={p.description}>
                  <Input value={runParams[p.name] ?? ''} onChange={(e) => setRunParams({ ...runParams, [p.name]: e.target.value })} />
                </Field>
              ))}
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  )
}

export function MacrosPage() {
  const list = useAsync(() => call('macros.list'))
  const [params, setParams] = useSearchParams()
  const selected = params.get('id')
  const { state, recordingSteps, setOpen } = useBrowser()

  useEffect(() => {
    if (!selected && list.data?.length) setParams({ id: list.data[0].id }, { replace: true })
  }, [list.data, selected, setParams])

  useEffect(() => {
    if (!state.recording) list.reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.recording])

  const macro = list.data?.find((m) => m.id === selected)

  const toggleRecording = async () => {
    try {
      if (state.recording) {
        const m = await call('macros.stopRecording')
        list.reload()
        if (m) setParams({ id: m.id })
        else toast('未录制到任何操作')
      } else {
        setOpen(true)
        await call('macros.startRecording')
        toast('开始录制', { description: '在右侧浏览器中操作，完成后点击停止' })
      }
    } catch (e) {
      toast.error('录制失败', { description: errorMessage(e) })
    }
  }

  return (
    <div className="@container flex h-full flex-col px-6 pt-6 pb-6 @4xl:px-8">
      <PageHeader
        title="录制宏"
        description="录制你在浏览器中的操作，回放或作为工具交给 Agent 调用。值中可用 {{参数}} 实现参数化。"
        actions={
          <Button variant={state.recording ? 'danger' : 'primary'} onClick={toggleRecording}>
            {state.recording ? <Square className="size-3 fill-current" /> : <Circle />}
            {state.recording ? `停止录制（${recordingSteps} 步）` : '开始录制'}
          </Button>
        }
      />
      <div className="flex min-h-0 flex-1 gap-4">
        <div className="w-52 shrink-0 overflow-y-auto @4xl:w-64">
          <AsyncView
            state={list}
            loading={<ListSkeleton rows={3} />}
            empty={<EmptyState icon={Clapperboard} title="还没有录制宏" description="点击「开始录制」，然后在右侧浏览器中完成一遍操作。" />}
          >
            {(macros) => (
              <div className="grid gap-px">
                {macros.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setParams({ id: m.id })}
                    className={cn('interactive rounded-md px-3 py-2.5 text-left', selected === m.id ? 'bg-accent' : 'hover:bg-accent/60')}
                  >
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{m.name}</span>
                      {m.exposeAsTool ? <Badge variant="primary">工具</Badge> : null}
                    </div>
                    <div className="mt-0.5 text-xs text-subtle-foreground">
                      {m.steps.length} 步 · {timeAgo(m.updatedAt)}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </AsyncView>
        </div>
        {macro ? (
          <MacroEditor
            key={macro.id}
            macro={macro}
            onSaved={(saved) => list.setData((prev) => (prev ?? []).map((x) => (x.id === saved.id ? saved : x)))}
            onDeleted={() => {
              setParams({})
              list.reload()
            }}
          />
        ) : null}
      </div>
    </div>
  )
}
