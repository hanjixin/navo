import { BarChart3 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { formatCost, formatTokens } from '@shared/pricing'
import type { ModelPricing, UsagePurpose, UsageReport, UsageTotals } from '@shared/types'
import { Page, PageHeader, Section } from '@/components/layout/page'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Field, Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { AsyncView, EmptyState, ListSkeleton } from '@/components/ui/states'
import { Switch } from '@/components/ui/switch'
import { Tooltip } from '@/components/ui/tooltip'
import { useAsync } from '@/hooks/use-async'
import { call, on } from '@/lib/ipc'
import { cn, errorMessage } from '@/lib/utils'
import { useChat } from '@/stores/chat'
import { useSettings } from '@/stores/settings'

const PURPOSE: Record<UsagePurpose, { label: string; background?: boolean }> = {
  chat: { label: '对话' },
  memory: { label: '记忆提取', background: true },
  'memory-tidy': { label: '记忆整理', background: true },
  skill: { label: 'Skill 复盘', background: true },
  flow: { label: '流程整理' },
  monitor: { label: '网页监控', background: true },
  test: { label: '模型测试' },
  other: { label: '其他' },
}

const tokens = (t: UsageTotals) => t.input + t.output

function sum(list: UsageTotals[]): UsageTotals {
  const out: UsageTotals = { calls: 0, input: 0, output: 0, cached: 0, cost: {}, unpriced: 0 }
  for (const t of list) {
    out.calls += t.calls
    out.input += t.input
    out.output += t.output
    out.cached += t.cached
    out.unpriced += t.unpriced
    for (const [c, v] of Object.entries(t.cost) as [ModelPricing['currency'], number][]) out.cost[c] = (out.cost[c] ?? 0) + v
  }
  return out
}

/** "¥1.20 + $0.03", or a dash when nothing has a price */
function Cost({ t, className }: { t: UsageTotals; className?: string }) {
  const parts = (Object.entries(t.cost) as [ModelPricing['currency'], number][]).map(([c, v]) => formatCost(v, c))
  return <span className={cn('tabular-nums', className)}>{parts.length ? parts.join(' + ') : '—'}</span>
}

function Stat({ label, t, hint }: { label: string; t: UsageTotals; hint?: React.ReactNode }) {
  return (
    <Card className="grid gap-1 px-4 py-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-baseline gap-2">
        <span className="text-xl font-semibold tabular-nums">{formatTokens(tokens(t))}</span>
        <span className="text-xs text-muted-foreground">tokens</span>
        <Cost t={t} className="ml-auto text-sm" />
      </div>
      <span className="text-xs text-subtle-foreground">{hint ?? `${t.calls} 次调用 · 输入 ${formatTokens(t.input)} · 输出 ${formatTokens(t.output)}`}</span>
    </Card>
  )
}

function DailyChart({ daily }: { daily: UsageReport['daily'] }) {
  const max = Math.max(1, ...daily.map(tokens))
  const every = daily.length > 10 ? 5 : 1
  return (
    <Card className="px-4 pt-4 pb-3">
      <div className="flex h-36 items-end gap-1" data-testid="usage-chart">
        {daily.map((d) => {
          const total = tokens(d)
          return (
            <Tooltip key={d.day} content={`${d.day} · ${formatTokens(total)} tokens · ${d.calls} 次`}>
              <div className="group flex h-full min-w-0 flex-1 flex-col justify-end">
                {total ? (
                  <div
                    className="flex flex-col overflow-hidden rounded-t-sm transition-opacity group-hover:opacity-80"
                    style={{ height: `${(total / max) * 100}%` }}
                  >
                    <div className="bg-brand" style={{ flex: d.output || 0 }} />
                    <div className="bg-brand/35" style={{ flex: d.input || 0 }} />
                  </div>
                ) : (
                  <div className="h-px bg-border" />
                )}
              </div>
            </Tooltip>
          )
        })}
      </div>
      <div className="mt-1.5 flex gap-1 text-[10px] text-subtle-foreground">
        {daily.map((d, i) => (
          <span key={d.day} className="min-w-0 flex-1 truncate text-center">
            {i % every === 0 || i === daily.length - 1 ? d.day.slice(5) : ''}
          </span>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-brand/35" />
          输入
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-brand" />
          输出
        </span>
      </div>
    </Card>
  )
}

/** One row of a breakdown: name, share bar, tokens, cost. */
function ShareRow({ name, t, of, hint, onClick }: { name: React.ReactNode; t: UsageTotals; of: number; hint?: string; onClick?: () => void }) {
  const share = of ? tokens(t) / of : 0
  const Row = onClick ? 'button' : 'div'
  return (
    <Row onClick={onClick} className={cn('grid w-full gap-1 px-4 py-2 text-left', onClick && 'interactive hover:bg-muted')}>
      <div className="flex items-center gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {hint ? <span className="shrink-0 text-xs text-subtle-foreground">{hint}</span> : null}
        <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{formatTokens(tokens(t))}</span>
        <Cost t={t} className="w-20 shrink-0 text-right text-xs" />
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-brand/70 transition-[width] duration-300" style={{ width: `${Math.max(share * 100, share ? 1 : 0)}%` }} />
      </div>
    </Row>
  )
}

function BudgetCard({ report }: { report: UsageReport }) {
  const settings = useSettings((s) => s.settings)
  const save = useSettings((s) => s.update)
  const load = useSettings((s) => s.load)
  const cfg = settings?.usage
  useEffect(() => {
    if (!settings) void load()
  }, [settings, load])
  const [budget, setBudget] = useState(cfg?.dailyBudget?.toString() ?? '')
  useEffect(() => setBudget(cfg?.dailyBudget?.toString() ?? ''), [cfg?.dailyBudget])
  if (!cfg) return null
  const update = async (patch: Partial<typeof cfg>) => {
    try {
      await save({ usage: { ...cfg, ...patch } })
    } catch (e) {
      toast.error('保存失败', { description: errorMessage(e) })
    }
  }
  const b = report.budget
  const ratio = b.daily ? Math.min(1, b.spentToday / b.daily) : 0
  return (
    <Card className="grid gap-4 px-4 py-4">
      <div className="grid grid-cols-[minmax(0,1fr)_120px] gap-3">
        <Field label="每日预算" hint="按模型上设置的单价估算；留空则不限制">
          <Input
            type="number"
            min={0}
            step="1"
            value={budget}
            placeholder="不限制"
            aria-label="每日预算"
            onChange={(e) => setBudget(e.target.value)}
            onBlur={() => void update({ dailyBudget: budget.trim() === '' || Number(budget) <= 0 ? null : Number(budget) })}
          />
        </Field>
        <Field label="币种">
          <Select
            value={cfg.currency}
            onChange={(v) => void update({ currency: v as ModelPricing['currency'] })}
            options={[
              { value: 'CNY', label: '人民币 ¥' },
              { value: 'USD', label: '美元 $' },
            ]}
          />
        </Field>
      </div>
      {b.daily ? (
        <div className="grid gap-1.5" data-testid="usage-budget">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>今日已用 {formatCost(b.spentToday, b.currency)}</span>
            <span>预算 {formatCost(b.daily, b.currency)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={cn('h-full rounded-full transition-[width] duration-300', ratio >= 1 ? 'bg-danger' : ratio > 0.8 ? 'bg-warning' : 'bg-brand')}
              style={{ width: `${ratio * 100}%` }}
            />
          </div>
          {b.paused ? <p className="text-xs text-warning">今日预算已用完：记忆整理、Skill 复盘和网页监控的判断暂停到明天。</p> : null}
        </div>
      ) : null}
      <label className="flex items-center justify-between gap-4 text-sm">
        <span>
          超出预算后暂停后台调用
          <span className="block text-xs text-muted-foreground">记忆提取与整理、Skill 复盘、网页监控的判断；对话不受影响</span>
        </span>
        <Switch checked={cfg.pauseBackground} onCheckedChange={(v) => void update({ pauseBackground: v })} />
      </label>
    </Card>
  )
}

export function UsagePage() {
  const [days, setDays] = useState(7)
  const report = useAsync(() => call('usage.report', days), [days])
  const select = useChat((s) => s.select)
  const navigate = useNavigate()

  useEffect(() => {
    // calls come in bursts (a run makes many): refresh at most every 2s
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = on('usage.changed', () => {
      timer ??= setTimeout(() => {
        timer = null
        report.reload()
      }, 2000)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days])

  return (
    <Page>
      <PageHeader
        title="用量"
        description="每次调用模型用掉的 token，以及按模型单价估算的费用（以服务商账单为准）。"
        actions={
          <div className="flex rounded-md border border-border bg-muted p-0.5" role="tablist">
            {[7, 30].map((d) => (
              <button
                key={d}
                role="tab"
                aria-selected={days === d}
                onClick={() => setDays(d)}
                className={cn(
                  'interactive h-7 rounded-[5px] px-3 text-sm',
                  days === d ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                近 {d} 天
              </button>
            ))}
          </div>
        }
      />
      <AsyncView
        state={report}
        loading={<ListSkeleton rows={4} />}
        isEmpty={(r) => r.total.calls === 0}
        empty={
          <>
            <Card className="mb-6">
              <EmptyState icon={BarChart3} title="还没有用量记录" description="对话、记忆整理、Skill 复盘、网页监控等每次调用模型后，用量会显示在这里。" />
            </Card>
            {report.data ? (
              <Section title="预算">
                <BudgetCard report={report.data} />
              </Section>
            ) : null}
          </>
        }
      >
        {(r) => {
          const all = tokens(r.total)
          const background = sum(r.byPurpose.filter((p) => PURPOSE[p.purpose]?.background))
          return (
            <div className="grid gap-6">
              <div className="grid gap-3 sm:grid-cols-3">
                <Stat label="今天" t={r.today} />
                <Stat label={`近 ${r.days} 天`} t={r.total} />
                <Stat
                  label="后台调用"
                  t={background}
                  hint={`占全部的 ${all ? Math.round((tokens(background) / all) * 100) : 0}% · 记忆、Skill 复盘、网页监控`}
                />
              </div>
              {r.total.unpriced > 0 ? (
                <p className="-mt-3 text-xs text-muted-foreground">
                  有 {formatTokens(r.total.unpriced)} tokens 来自没有设置价格的模型，未计入费用。
                  <Button variant="link" size="sm" className="h-auto px-1 text-xs" onClick={() => navigate('/models')}>
                    去设置价格
                  </Button>
                </p>
              ) : null}
              <Section title="每日用量">
                <DailyChart daily={r.daily} />
              </Section>
              <div className="grid gap-6 lg:grid-cols-2">
                <Section title="按用途">
                  <Card className="divide-y divide-border py-1" data-testid="usage-purpose">
                    {r.byPurpose.map((p) => (
                      <ShareRow key={p.purpose} name={PURPOSE[p.purpose]?.label ?? p.purpose} t={p} of={all} hint={`${p.calls} 次`} />
                    ))}
                  </Card>
                </Section>
                <Section title="按模型">
                  <Card className="divide-y divide-border py-1" data-testid="usage-model">
                    {r.byModel.map((m) => (
                      <ShareRow key={m.modelId ?? m.name} name={m.name} t={m} of={all} hint={Object.keys(m.cost).length ? undefined : '未设价格'} />
                    ))}
                  </Card>
                </Section>
              </div>
              {r.topThreads.length ? (
                <Section title="用量最多的对话">
                  <Card className="divide-y divide-border py-1" data-testid="usage-threads">
                    {r.topThreads.map((t) => (
                      <ShareRow
                        key={t.threadId}
                        name={t.title}
                        t={t}
                        of={tokens(r.topThreads[0])}
                        hint={`${t.calls} 次`}
                        onClick={() => {
                          select(t.threadId)
                          navigate('/chat')
                        }}
                      />
                    ))}
                  </Card>
                </Section>
              ) : null}
              <Section title="预算">
                <BudgetCard report={r} />
              </Section>
            </div>
          )
        }}
      </AsyncView>
    </Page>
  )
}
