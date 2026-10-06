import { Check, GitCompareArrows, History, Sparkles, Undo2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { SkillProposal, SkillStats, SkillVersion } from '@shared/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { EmptyState, ErrorState, ListSkeleton } from '@/components/ui/states'
import { Switch } from '@/components/ui/switch'
import { lineDiff } from '@/lib/diff'
import { call } from '@/lib/ipc'
import { cn, errorMessage, timeAgo } from '@/lib/utils'
import { useSettings } from '@/stores/settings'

const KIND_LABEL: Record<SkillProposal['kind'], string> = {
  create: '建议新建',
  rewrite: '建议重写',
  patch: '建议修改',
  fork: '建议保存改进后的本地副本',
  rollback: '建议回滚',
}
const SOURCE_LABEL: Record<SkillVersion['source'], string> = {
  user: '你编辑',
  import: '原始内容',
  'agent-patch': '自动改进',
  'agent-proposal': '你批准的建议',
  experience: '由经验整理',
  rollback: '回滚',
}

// ---------- diff view

export function DiffView({ before, after, className }: { before: string; after: string; className?: string }) {
  const lines = useMemo(() => lineDiff(before, after), [before, after])
  return (
    <pre className={cn('selectable overflow-auto rounded-md border border-border bg-muted p-3 font-mono text-xs leading-relaxed', className)}>
      {lines.map((l, k) => (
        <div
          key={k}
          data-diff={l.type}
          className={cn(
            'whitespace-pre-wrap',
            l.type === 'add' && 'bg-success-soft text-foreground',
            l.type === 'del' && 'bg-danger-soft text-muted-foreground line-through',
          )}
        >
          <span className="mr-2 inline-block w-3 text-subtle-foreground select-none">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
          {l.text || ' '}
        </div>
      ))}
    </pre>
  )
}

// ---------- suggestions waiting for the user

export function ProposalCards({ proposals }: { proposals: SkillProposal[] }) {
  const [open, setOpen] = useState<SkillProposal | null>(null)
  const decide = (p: SkillProposal, approve: boolean) =>
    void call('skills.resolveProposal', p.id, approve).then(
      () => {
        toast.success(approve ? `已应用到 Skill「${p.skill}」` : '已忽略这条建议')
        setOpen(null)
      },
      (e) => toast.error('操作失败', { description: errorMessage(e) }),
    )
  if (!proposals.length) return null
  return (
    <div className="mb-4 grid gap-2">
      {proposals.map((p) => (
        <div
          key={p.id}
          data-testid="skill-proposal"
          className="flex items-start gap-3 rounded-lg border border-l-2 border-border border-l-primary bg-card px-4 py-3"
        >
          <Sparkles className="mt-0.5 size-4 shrink-0 stroke-[1.75] text-brand" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
              {KIND_LABEL[p.kind]}
              <code className="font-mono text-xs">{p.skill}</code>
              <span className="text-xs font-normal text-subtle-foreground">{timeAgo(p.at)}</span>
            </div>
            {p.reason ? <p className="mt-0.5 text-sm text-muted-foreground">{p.reason}</p> : null}
            {p.evidence ? <p className="mt-0.5 line-clamp-2 text-xs text-subtle-foreground">依据：{p.evidence}</p> : null}
          </div>
          <div className="flex shrink-0 gap-1">
            <Button variant="ghost" size="sm" onClick={() => setOpen(p)}>
              <GitCompareArrows />
              查看改动
            </Button>
            <Button variant="secondary" size="sm" onClick={() => decide(p, true)}>
              <Check />
              批准
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="忽略这条建议" onClick={() => decide(p, false)}>
              <X />
            </Button>
          </div>
        </div>
      ))}
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        {open ? (
          <DialogContent
            title={`${KIND_LABEL[open.kind]} · ${open.skill}`}
            description={open.reason}
            className="w-[min(860px,calc(100vw-48px))]"
            footer={
              <>
                <Button variant="ghost" onClick={() => decide(open, false)}>
                  忽略
                </Button>
                <Button variant="primary" onClick={() => decide(open, true)}>
                  批准并应用
                </Button>
              </>
            }
          >
            <DiffView before={open.before} after={open.content} className="max-h-[56vh]" />
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  )
}

// ---------- versions

export function SkillHistoryDialog({ skill, stats, onClose, onChanged }: { skill: string; stats?: SkillStats; onClose: () => void; onChanged: () => void }) {
  const [versions, setVersions] = useState<SkillVersion[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<number | null>(null)
  const load = () =>
    void call('skills.versions', skill).then(
      (v) => {
        setVersions(v)
        setPicked((p) => p ?? v[0]?.version ?? null)
      },
      (e) => setError(errorMessage(e)),
    )
  useEffect(load, [skill])
  const cur = versions?.find((v) => v.version === picked)
  const prev = versions?.find((v) => v.version === (picked ?? 0) - 1)
  const latest = versions?.[0]?.version

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`版本记录 · ${skill}`}
        description={
          stats?.uses
            ? `用过 ${stats.uses} 次：${stats.ok} 次顺利${stats.corrected ? `，${stats.corrected} 次被纠正` : ''}${stats.failed ? `，${stats.failed} 次没完成` : ''}`
            : '还没有使用记录'
        }
        className="h-[78vh] w-[min(980px,calc(100vw-48px))]"
      >
        {error ? (
          <ErrorState error={error} onRetry={load} />
        ) : !versions ? (
          <ListSkeleton rows={4} />
        ) : !versions.length ? (
          <EmptyState icon={History} title="还没有版本记录" description="这个 Skill 被修改后，每次改动都会记在这里，可以对比和回滚。" />
        ) : (
          <div className="flex h-full min-h-0 gap-4">
            <div className="w-64 shrink-0 overflow-y-auto">
              <div className="grid gap-1">
                {versions.map((v) => (
                  <button
                    key={v.version}
                    data-testid="skill-version"
                    onClick={() => setPicked(v.version)}
                    className={cn('interactive rounded-md px-3 py-2 text-left', picked === v.version ? 'bg-accent' : 'hover:bg-accent/60')}
                  >
                    <div className="flex items-center gap-2 text-sm">
                      <span className="font-medium">版本 {v.version}</span>
                      {v.version === latest ? <Badge variant="primary">当前</Badge> : null}
                      <span className="ml-auto text-xs text-subtle-foreground">{timeAgo(v.at)}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{SOURCE_LABEL[v.source]}</div>
                    {v.reason ? <div className="mt-0.5 line-clamp-2 text-xs text-subtle-foreground">{v.reason}</div> : null}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              {cur ? (
                <>
                  <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                    {prev ? `与版本 ${prev.version} 相比的改动` : '最早的版本'}
                    {cur.version !== latest ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="ml-auto"
                        onClick={() =>
                          void call('skills.rollback', skill, cur.version).then(
                            () => {
                              toast.success(`已回到版本 ${cur.version}`)
                              setPicked(null)
                              load()
                              onChanged()
                            },
                            (e) => toast.error('回滚失败', { description: errorMessage(e) }),
                          )
                        }
                      >
                        <Undo2 />
                        回滚到这个版本
                      </Button>
                    ) : null}
                  </div>
                  <DiffView before={prev?.content ?? ''} after={cur.content} className="min-h-0 flex-1" />
                </>
              ) : null}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ---------- settings

export function EvolutionSettingsDialog({ onClose }: { onClose: () => void }) {
  const { settings, update } = useSettings()
  const cfg = settings!.skills
  const row = (label: string, hint: string, value: boolean, onChange: (v: boolean) => void, disabled = false) => (
    <label className={cn('flex items-center justify-between gap-4 text-sm', disabled && 'opacity-60')}>
      <span>
        {label}
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <Switch checked={value} onCheckedChange={onChange} disabled={disabled} />
    </label>
  )
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Skill 自迭代"
        description="Navo 会在对话空闲时回看刚做完的事：Skill 用得不顺就修正它，做成了的多步任务可以沉淀成新 Skill。"
        footer={
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        }
      >
        <div className="grid gap-5">
          {row(
            '开启自迭代',
            '关闭后不再回看对话，也不会产生改进或建议（会少一次后台模型调用）。',
            cfg.selfImprove,
            (v) => void update({ skills: { ...cfg, selfImprove: v } }),
          )}
          {row(
            '小改动自动生效',
            '给本地 Skill 补一条注意事项、修正一个步骤这类小改动直接生效并记版本，可随时回滚。关闭后所有改动都先等你确认。',
            cfg.autoApplySmall,
            (v) => void update({ skills: { ...cfg, autoApplySmall: v } }),
            !cfg.selfImprove,
          )}
          {row(
            '经验自动整理成 Skill',
            '同一类多步任务顺利做过两次以上，或一个网站积累了 3 条以上站点经验时，自动整理成 Skill。关闭后只给出建议。',
            cfg.autoCreateFromExperience,
            (v) => void update({ skills: { ...cfg, autoCreateFromExperience: v } }),
            !cfg.selfImprove,
          )}
          <p className="text-xs text-subtle-foreground">新建 Skill、大幅改写、以及对共享只读 Skill 的改进，始终先作为建议等你批准。</p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
