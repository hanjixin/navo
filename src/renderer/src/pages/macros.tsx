import { ArrowDown, ArrowUp, Bot, Circle, Clapperboard, History, Play, Plus, Save, Sparkles, Square, Trash2, Undo2, Wrench, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { toast } from 'sonner'
import type { FlowStats, Macro, MacroRunResult, MacroStep, MacroStepType, MacroVersion } from '@shared/types'
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
import { call, on } from '@/lib/ipc'
import { cn, errorMessage, timeAgo } from '@/lib/utils'
import { useBrowser } from '@/stores/browser'
import { useChat } from '@/stores/chat'
import { t } from '@shared/i18n'

const STEP_LABEL: Record<MacroStepType, string> = {
  navigate: t('打开'),
  click: t('点击'),
  type: t('输入'),
  select: t('选择'),
  press: t('按键'),
  wait: t('等待'),
  scroll: t('滚动'),
  extract: t('提取'),
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
            <Input
              value={step.label ?? ''}
              onChange={(e) => onChange({ ...step, label: e.target.value })}
              placeholder={t('结果名称')}
              className="h-7 text-xs"
            />
            <Input
              value={step.selectors?.[0] ?? ''}
              onChange={(e) => onChange({ ...step, selectors: e.target.value ? [e.target.value] : [] })}
              placeholder={t('CSS 选择器（留空为全文）')}
              className="h-7 font-mono text-xs"
            />
          </div>
        ) : null}
        {editableValue ? (
          <Input
            value={step.value ?? ''}
            onChange={(e) => onChange({ ...step, value: e.target.value })}
            placeholder={step.type === 'wait' ? t('毫秒，或填写选择器等待元素') : step.type === 'scroll' ? t('像素') : t('值，可用 {{参数名}}')}
            className="mt-2 h-7 font-mono text-xs"
          />
        ) : null}
      </div>
      <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <Button variant="ghost" size="icon-sm" disabled={index === 0} onClick={() => onMove(-1)} aria-label={t('上移')}>
          <ArrowUp />
        </Button>
        <Button variant="ghost" size="icon-sm" disabled={index === total - 1} onClick={() => onMove(1)} aria-label={t('下移')}>
          <ArrowDown />
        </Button>
        <Button variant="ghost" size="icon-sm" className="hover:text-danger" onClick={onDelete} aria-label={t('删除步骤')}>
          <X />
        </Button>
      </div>
    </div>
  )
}

const VERSION_SOURCE: Record<MacroVersion['source'], string> = {
  recorded: t('录制'),
  agent: t('由对话整理'),
  repair: t('Agent 自动修复'),
  user: t('手动编辑'),
  rollback: t('回滚'),
}

/** Replays, automatic repairs and versions of a flow. */
function useFlowStats(macroId: string) {
  const [stats, setStats] = useState<FlowStats | null>(null)
  useEffect(() => {
    const load = () => void call('flows.stats').then((s) => setStats(s[macroId] ?? null))
    load()
    return on('macros.changed', load)
  }, [macroId])
  return stats
}

function VersionsDialog({ macro, onClose, onRolledBack }: { macro: Macro; onClose: () => void; onRolledBack: () => void }) {
  const versions = useAsync(() => call('flows.versions', macro.id), [macro.id])
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={t('版本记录 · {{v0}}', { v0: macro.name })}
        description={t('每次录制、整理、修复和编辑都会记一个版本，可以回到任意一个。')}
        className="w-[560px]"
      >
        <AsyncView
          state={versions}
          loading={<ListSkeleton rows={3} />}
          empty={<p className="py-6 text-center text-sm text-muted-foreground">{t('还没有版本记录')}</p>}
        >
          {(list) => (
            <div className="grid gap-1.5">
              {list.map((v, i) => (
                <div key={v.version} data-testid="macro-version" className="flex items-center gap-3 rounded-md border border-border px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium">{t('版本 {{v0}}', { v0: v.version })}</span>
                      {i === 0 ? <Badge variant="primary">{t('当前')}</Badge> : null}
                      <span className="text-xs text-muted-foreground">{VERSION_SOURCE[v.source]}</span>
                    </div>
                    <div className="text-xs text-subtle-foreground">
                      {v.reason ? `${v.reason} · ` : ''}
                      {t('{{v0}} 步 · {{v1}}', { v0: v.steps, v1: timeAgo(v.at) })}
                    </div>
                  </div>
                  {i > 0 ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void call('flows.rollback', macro.id, v.version).then(
                          () => {
                            toast.success(t('已回到版本 {{v0}}', { v0: v.version }))
                            onRolledBack()
                            onClose()
                          },
                          (e) => toast.error(t('回滚失败'), { description: errorMessage(e) }),
                        )
                      }
                    >
                      <Undo2 />
                      {t('回到这版')}
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </AsyncView>
      </DialogContent>
    </Dialog>
  )
}

function MacroEditor({ macro, onSaved, onDeleted }: { macro: Macro; onSaved: (m: Macro) => void; onDeleted: () => void }) {
  const [m, setM] = useState(macro)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [runParams, setRunParams] = useState<Record<string, string> | null>(null)
  const [result, setResult] = useState<MacroRunResult | null>(null)
  const [lastParams, setLastParams] = useState<Record<string, string>>({})
  const [repairing, setRepairing] = useState(false)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const stats = useFlowStats(macro.id)
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
          label: type === 'extract' ? t('结果{{v0}}', { v0: m.steps.length + 1 }) : undefined,
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
      toast.success(t('宏已保存'))
    } catch (e) {
      toast.error(t('保存失败'), { description: errorMessage(e) })
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
      setLastParams(params)
      const r = await call('macros.run', m.id, params)
      setResult(r)
      if (r.ok) toast.success(t('宏执行完成'))
    } catch (e) {
      setResult({ ok: false, error: errorMessage(e), extracted: {} })
    } finally {
      setRunning(false)
    }
  }

  /** Replays again in the background; where it breaks, the agent finishes and the flow is updated. */
  const repair = async () => {
    setRepairing(true)
    try {
      const r = await call('flows.run', m.id, lastParams, true)
      setResult(r)
      if (r.ok) {
        toast.success(r.repaired ? t('已由 Agent 修复，流程已更新') : t('这次回放成功了，无需修复'))
        const fresh = (await call('macros.list')).find((x) => x.id === m.id)
        if (fresh) onSaved(fresh)
      } else toast.error(t('修复没有完成'), { description: r.error })
    } catch (e) {
      toast.error(t('修复失败'), { description: errorMessage(e) })
    } finally {
      setRepairing(false)
    }
  }

  const handToAgent = async () => {
    if (!result || result.ok) return
    const step = m.steps[result.failedStep ?? 0]
    await newThread()
    navigate('/chat')
    void send(
      t(
        '我在运行录制宏「{{v0}}」时，第 {{v1}} 步失败：{{v2}}\n失败步骤：{{v3}}\n\n全部步骤：\n{{v4}}\n\n请基于当前浏览器页面，从失败的步骤开始继续完成剩余操作。',
        {
          v0: m.name,
          v1: (result.failedStep ?? 0) + 1,
          v2: result.error,
          v3: JSON.stringify(step),
          v4: m.steps.map((s, i) => `${i + 1}. ${STEP_LABEL[s.type]} ${s.url ?? s.label ?? ''} ${s.value ? t('值={{v0}}', { v0: s.value }) : ''}`).join('\n'),
        },
      ),
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-2">
        <div className="flex min-w-48 flex-1 items-center gap-2">
          <Input value={m.name} onChange={(e) => update({ name: e.target.value })} className="h-9 max-w-md min-w-0 text-base font-semibold" />
          {dirty ? <span className="shrink-0 text-xs text-warning">{t('未保存')}</span> : null}
        </div>
        <div className="ml-auto flex flex-wrap justify-end gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => setVersionsOpen(true)}>
            <History />
            {t('版本')}
            {stats?.version ? ` ${stats.version}` : ''}
          </Button>
          <Button variant="ghost" size="sm" className="hover:text-danger" onClick={async () => (await call('macros.delete', m.id), onDeleted())}>
            <Trash2 />
            {t('删除')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              try {
                const name = await call('macros.toSkill', m.id)
                toast.success(t('已生成 Skill：{{v0}}', { v0: name }), { action: { label: t('查看'), onClick: () => navigate('/skills') } })
              } catch (e) {
                toast.error(t('生成失败'), { description: errorMessage(e) })
              }
            }}
          >
            <Sparkles />
            {t('生成 Skill')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={running}
            onClick={() => (m.params.length ? setRunParams(Object.fromEntries(m.params.map((p) => [p.name, p.default ?? '']))) : void run({}))}
          >
            {!running ? <Play /> : null}
            {t('运行')}
          </Button>
          <Button variant="primary" size="sm" loading={saving} disabled={!dirty} onClick={save}>
            {!saving ? <Save /> : null}
            {t('保存')}
          </Button>
        </div>
        {stats?.runs ? (
          <p data-testid="flow-stats" className="w-full text-xs text-subtle-foreground">
            {t('已回放 {{v0}} 次', { v0: stats.runs })}
            {stats.repaired ? t(' · 自动修复 {{v0}} 次', { v0: stats.repaired }) : ''}
            {stats.failed ? t(' · 失败 {{v0}} 次', { v0: stats.failed }) : ''}
            {stats.modelCalls ? t(' · 修复共调用模型 {{v0}} 次', { v0: stats.modelCalls }) : t(' · 未调用模型')}
          </p>
        ) : null}
      </div>

      {result ? (
        result.ok ? (
          <div className="mb-4 animate-fade-in rounded-lg border border-l-2 border-border border-l-success bg-success-soft px-4 py-3 text-sm">
            <span className="font-medium">{t('执行成功')}</span>
            {Object.keys(result.extracted).length ? (
              <pre className="selectable mt-2 max-h-40 overflow-auto font-mono text-xs whitespace-pre-wrap text-muted-foreground">
                {JSON.stringify(result.extracted, null, 2)}
              </pre>
            ) : null}
          </div>
        ) : (
          <div className="mb-4 flex animate-fade-in items-start gap-3 rounded-lg border border-l-2 border-border border-l-danger bg-danger-soft px-4 py-3">
            <div className="min-w-0 flex-1 text-sm">
              <span className="font-medium">{t('第 {{v0}} 步执行失败', { v0: (result.failedStep ?? 0) + 1 })}</span>
              <p className="mt-0.5 text-xs break-words text-muted-foreground">{result.error}</p>
            </div>
            <div className="flex shrink-0 gap-1.5">
              <Button variant="primary" size="sm" loading={repairing} onClick={() => void repair()}>
                {!repairing ? <Wrench /> : null}
                {t('让 Agent 修复并更新流程')}
              </Button>
              <Button variant="secondary" size="sm" onClick={handToAgent}>
                <Bot />
                {t('交给 Agent 继续')}
              </Button>
            </div>
          </div>
        )
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-y-auto @5xl:grid-cols-[1fr_280px] @5xl:overflow-visible">
        <Card className="flex min-h-0 flex-col">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <span className="text-sm font-medium">{t('步骤 · {{v0}}', { v0: m.steps.length })}</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm">
                  <Plus />
                  {t('添加步骤')}
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
                {t('起始页面')} <span className="font-mono">{m.startUrl}</span>
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
            <Field label={t('描述')} hint={t('作为工具描述提供给 Agent')}>
              <Input value={m.description} onChange={(e) => update({ description: e.target.value })} placeholder={t('这个宏做什么')} />
            </Field>
            <Field label={t('起始网址')} hint={t('留空则在当前页运行')}>
              <Input value={m.startUrl ?? ''} onChange={(e) => update({ startUrl: e.target.value })} className="font-mono text-xs" />
            </Field>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>
                {t('作为 Agent 工具')}
                <span className="block text-xs text-muted-foreground">{t('对话中可直接调用')}</span>
              </span>
              <Switch checked={m.exposeAsTool} onCheckedChange={(v) => update({ exposeAsTool: v })} />
            </label>
          </Card>
          <Card className="p-4">
            <div className="text-sm font-medium">{t('参数')}</div>
            <p className="mt-0.5 mb-3 text-xs text-muted-foreground">
              {t('在步骤的值中使用')} <code className="font-mono">{'{{name}}'}</code> {t('即可声明参数，保存后自动出现。')}
            </p>
            {m.params.length ? (
              <div className="grid gap-3">
                {m.params.map((p, i) => (
                  <div key={p.name} className="grid gap-1.5">
                    <code className="font-mono text-xs font-medium">{p.name}</code>
                    <Input
                      value={p.default ?? ''}
                      placeholder={t('默认值')}
                      className="h-7 text-xs"
                      onChange={(e) => update({ params: m.params.map((x, j) => (j === i ? { ...x, default: e.target.value } : x)) })}
                    />
                    <Input
                      value={p.description ?? ''}
                      placeholder={t('说明（给 Agent 看）')}
                      className="h-7 text-xs"
                      onChange={(e) => update({ params: m.params.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)) })}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-subtle-foreground">{t('暂无参数')}</p>
            )}
          </Card>
        </div>
      </div>

      <Dialog open={!!runParams} onOpenChange={(o) => !o && setRunParams(null)}>
        {runParams ? (
          <DialogContent
            title={t('运行参数')}
            className="w-[440px]"
            footer={
              <>
                <Button variant="ghost" onClick={() => setRunParams(null)}>
                  {t('取消')}
                </Button>
                <Button variant="primary" onClick={() => void run(runParams)}>
                  {t('运行')}
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
      {versionsOpen ? (
        <VersionsDialog
          macro={m}
          onClose={() => setVersionsOpen(false)}
          onRolledBack={() =>
            void call('macros.list').then((l) => {
              const f = l.find((x) => x.id === m.id)
              if (f) onSaved(f)
            })
          }
        />
      ) : null}
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
        else toast(t('未录制到任何操作'))
      } else {
        setOpen(true)
        await call('macros.startRecording')
        toast(t('开始录制'), { description: t('在右侧浏览器中操作，完成后点击停止') })
      }
    } catch (e) {
      toast.error(t('录制失败'), { description: errorMessage(e) })
    }
  }

  return (
    <div className="@container flex h-full flex-col px-6 pt-6 pb-6 @4xl:px-8">
      <PageHeader
        title={t('录制宏')}
        description={t('录制你在浏览器中的操作，回放或作为工具交给 Agent 调用。值中可用 {{参数}} 实现参数化。')}
        actions={
          <Button variant={state.recording ? 'danger' : 'primary'} onClick={toggleRecording}>
            {state.recording ? <Square className="size-3 fill-current" /> : <Circle />}
            {state.recording ? t('停止录制（{{v0}} 步）', { v0: recordingSteps }) : t('开始录制')}
          </Button>
        }
      />
      <div className="flex min-h-0 flex-1 gap-4">
        <div className="w-52 shrink-0 overflow-y-auto @4xl:w-64">
          <AsyncView
            state={list}
            loading={<ListSkeleton rows={3} />}
            empty={<EmptyState icon={Clapperboard} title={t('还没有录制宏')} description={t('点击「开始录制」，然后在右侧浏览器中完成一遍操作。')} />}
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
                      {m.exposeAsTool ? <Badge variant="primary">{t('工具')}</Badge> : null}
                    </div>
                    <div className="mt-0.5 text-xs text-subtle-foreground">{t('{{v0}} 步 · {{v1}}', { v0: m.steps.length, v1: timeAgo(m.updatedAt) })}</div>
                  </button>
                ))}
              </div>
            )}
          </AsyncView>
        </div>
        {macro ? (
          <MacroEditor
            // remount on outside changes (a repair or rollback rewrote the steps)
            key={`${macro.id}:${macro.updatedAt}`}
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
