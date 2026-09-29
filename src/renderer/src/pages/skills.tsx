import { Copy, FolderCog, FolderInput, FolderOpen, FolderPlus, Lock, Plus, RotateCw, Save, Sparkles, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { Skill } from '@shared/types'
import { CodeEditor } from '@/components/code-editor'
import { PageHeader } from '@/components/layout/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/input'
import { AsyncView, EmptyState, ErrorState, ListSkeleton, Skeleton } from '@/components/ui/states'
import { Switch } from '@/components/ui/switch'
import { Tooltip } from '@/components/ui/tooltip'
import { useAsync } from '@/hooks/use-async'
import { call } from '@/lib/ipc'
import { cn, errorMessage } from '@/lib/utils'

const template = (name: string) => `---
name: ${name}
description: 一句话说明这个 Skill 做什么、何时使用（Agent 依据它决定是否加载）
---

# ${name}

## 何时使用
- …

## 步骤
1. …
2. …

## 注意事项
- …
`

function SourcesDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const sources = useAsync(() => call('skills.sources'))
  const add = async () => {
    try {
      const s = await call('skills.addSource')
      if (s) {
        toast.success(`已添加来源：${s.label}`, { description: `发现 ${s.skillCount} 个 Skill` })
        sources.reload()
        onChanged()
      }
    } catch (e) {
      toast.error('添加失败', { description: errorMessage(e) })
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Skill 来源"
        description="除本地 Skill 外，还会扫描其他 Agent 共享的目录。外部 Skill 以只读方式提供给 Agent，不会被复制或修改。"
        footer={
          <>
            <Button variant="secondary" onClick={add}>
              <FolderPlus />
              添加目录
            </Button>
            <Button variant="primary" onClick={onClose}>
              完成
            </Button>
          </>
        }
      >
        <AsyncView state={sources} loading={<ListSkeleton rows={3} />}>
          {(list) => (
            <div className="grid gap-1">
              {list.map((s) => (
                <div key={s.id} className="flex items-center gap-3 rounded-md px-3 py-2.5 hover:bg-accent/50">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {s.label}
                      {s.builtin && s.id !== 'local' ? <Badge variant="outline">内置</Badge> : null}
                    </div>
                    <div className="truncate font-mono text-xs text-muted-foreground">{s.path}</div>
                  </div>
                  <span className={cn('text-xs', s.exists ? 'text-muted-foreground' : 'text-subtle-foreground')}>
                    {s.exists ? `${s.skillCount} 个` : '目录不存在'}
                  </span>
                  {!s.builtin ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="移除来源"
                      onClick={async () => {
                        await call('skills.removeSource', s.id)
                        sources.reload()
                        onChanged()
                      }}
                    >
                      <X />
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

export function SkillsPage() {
  const list = useAsync(() => call('skills.list'))
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [creating, setCreating] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [q, setQ] = useState('')

  const groups = useMemo(() => {
    const m = new Map<string, Skill[]>()
    for (const s of list.data ?? []) {
      if (q && !`${s.name} ${s.description}`.toLowerCase().includes(q.toLowerCase())) continue
      const k = s.source === 'local' ? '本地' : s.sourceLabel
      m.set(k, [...(m.get(k) ?? []), s])
    }
    return [...m.entries()]
  }, [list.data, q])

  useEffect(() => {
    if (!selected && list.data?.length) setSelected(list.data[0].id)
  }, [list.data, selected])

  const current = list.data?.find((s) => s.id === selected)

  useEffect(() => {
    if (!selected) return
    setContent(null)
    setLoadError(null)
    setDirty(false)
    call('skills.read', selected).then(setContent, (e) => setLoadError(errorMessage(e)))
  }, [selected])

  const save = async () => {
    if (!current || current.readOnly || content == null) return
    setSaving(true)
    try {
      await call('skills.save', current.id, content)
      setDirty(false)
      toast.success('已保存 Skill')
      list.reload()
    } catch (e) {
      toast.error('保存失败', { description: errorMessage(e) })
    } finally {
      setSaving(false)
    }
  }

  const create = async () => {
    const name = newName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
    try {
      await call('skills.save', name, template(name))
      setCreating(false)
      setNewName('')
      list.reload()
      setSelected(name)
    } catch (e) {
      toast.error('创建失败', { description: errorMessage(e) })
    }
  }

  const toggle = async (s: Skill, enabled: boolean) => {
    list.setData((prev) => (prev ?? []).map((x) => (x.id === s.id ? { ...x, enabled } : x)))
    try {
      await call('skills.setEnabled', s.id, enabled)
    } catch (e) {
      toast.error('操作失败', { description: errorMessage(e) })
      list.reload()
    }
  }

  const copyToLocal = async () => {
    if (!current) return
    try {
      const s = await call('skills.copyToLocal', current.id)
      toast.success(`已复制到本地：${s.name}`, { description: '本地版本会覆盖同名的外部 Skill' })
      list.reload()
      setSelected(s.id)
    } catch (e) {
      toast.error('复制失败', { description: errorMessage(e) })
    }
  }

  const total = list.data?.length ?? 0
  const enabled = list.data?.filter((s) => s.enabled && !s.shadowed).length ?? 0

  return (
    <div className="@container flex h-full flex-col px-6 pt-6 pb-6 @4xl:px-8">
      <PageHeader
        title="Skill"
        description={
          <>
            可复用的专业流程说明（SKILL.md）。同时扫描 <code className="font-mono text-xs">~/.agents/skills</code> 等共享目录，Agent 按描述按需加载。
            {total ? (
              <span className="ml-1 text-subtle-foreground">
                · {enabled}/{total} 已启用
              </span>
            ) : null}
          </>
        }
        actions={
          <>
            <Tooltip content="重新扫描">
              <Button variant="ghost" size="icon" onClick={list.reload} aria-label="重新扫描">
                <RotateCw className={cn(list.loading && 'animate-spin')} />
              </Button>
            </Tooltip>
            <Button variant="secondary" onClick={() => setSourcesOpen(true)}>
              <FolderCog />
              来源
            </Button>
            <Button
              variant="secondary"
              onClick={async () => {
                const imported = await call('skills.import')
                if (imported.length) toast.success(`已导入 ${imported.length} 个 Skill`)
                list.reload()
              }}
            >
              <FolderInput />
              导入
            </Button>
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus />
              新建 Skill
            </Button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1 gap-4">
        <div className="flex w-56 shrink-0 flex-col @4xl:w-72">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索 Skill" className="mb-3 h-7 text-xs" />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <AsyncView
              state={list}
              loading={<ListSkeleton rows={4} />}
              empty={
                <EmptyState
                  icon={Sparkles}
                  title="还没有 Skill"
                  description="新建一个 Skill，或在「来源」中添加其他 Agent 的 Skill 目录。"
                  action={
                    <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                      新建 Skill
                    </Button>
                  }
                />
              }
            >
              {() =>
                groups.length ? (
                  <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
                    {groups.map(([label, items]) => (
                      <div key={label}>
                        <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[11px] font-medium tracking-wide text-subtle-foreground">
                          {label !== '本地' ? <Lock className="size-3" /> : null}
                          <span className="truncate">{label}</span>
                          <span className="ml-auto">{items.length}</span>
                        </div>
                        <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
                          {items.map((s) => (
                            <div
                              key={s.id}
                              onClick={() => setSelected(s.id)}
                              className={cn(
                                'card-hover cursor-default rounded-lg border bg-card px-3.5 py-3',
                                selected === s.id ? 'border-primary/40 ring-1 ring-primary/15' : 'border-border',
                              )}
                            >
                              <div className="flex items-center gap-2">
                                <span
                                  className={cn('min-w-0 flex-1 truncate font-mono text-sm font-medium', (!s.enabled || s.shadowed) && 'text-muted-foreground')}
                                >
                                  {s.name}
                                </span>
                                <Switch checked={s.enabled} onClick={(e) => e.stopPropagation()} onCheckedChange={(v) => void toggle(s, v)} aria-label="启用" />
                              </div>
                              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{s.description || '（缺少描述）'}</p>
                              {s.origin || s.shadowed ? (
                                <div className="mt-1.5 flex flex-wrap gap-1">
                                  {s.origin ? <Badge variant="outline">{s.origin}</Badge> : null}
                                  {s.shadowed ? <Badge variant="warning">已被本地同名覆盖</Badge> : null}
                                </div>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="px-2 py-8 text-center text-xs text-muted-foreground">没有匹配的 Skill</p>
                )
              }
            </AsyncView>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          {!current ? (
            list.data?.length ? null : (
              <div className="flex-1 rounded-lg border border-dashed border-border" />
            )
          ) : loadError ? (
            <ErrorState error={loadError} onRetry={() => setSelected((s) => s)} />
          ) : content == null ? (
            <div className="grid gap-2">
              <Skeleton className="h-8 w-1/3" />
              <Skeleton className="h-[420px]" />
            </div>
          ) : (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="min-w-0 truncate font-mono text-sm font-medium">
                  {current.readOnly ? current.path.replace(/^\/Users\/[^/]+/, '~') : `${current.name}/SKILL.md`}
                </span>
                {dirty ? <span className="text-xs text-warning">未保存</span> : null}
                <div className="ml-auto flex gap-1.5">
                  <Button variant="ghost" size="sm" onClick={() => void call('skills.reveal', current.id)}>
                    <FolderOpen />
                    打开目录
                  </Button>
                  {current.readOnly ? (
                    <Button variant="primary" size="sm" onClick={copyToLocal} disabled={current.shadowed}>
                      <Copy />
                      复制到本地编辑
                    </Button>
                  ) : (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="hover:text-danger"
                        onClick={async () => {
                          await call('skills.delete', current.id)
                          setSelected(null)
                          list.reload()
                        }}
                      >
                        <Trash2 />
                        删除
                      </Button>
                      <Button variant="primary" size="sm" loading={saving} disabled={!dirty} onClick={save}>
                        {!saving ? <Save /> : null}
                        保存
                      </Button>
                    </>
                  )}
                </div>
              </div>
              {current.readOnly ? (
                <div className="mb-2 flex animate-fade-in items-center gap-2 rounded-md bg-info-soft px-3 py-2 text-xs text-muted-foreground">
                  <Lock className="size-3.5 shrink-0 text-brand" />
                  来自 {current.sourceLabel}，与其他 Agent 共享，这里以只读方式使用。{current.shadowed ? '本地已有同名 Skill，Agent 会优先使用本地版本。' : ''}
                </div>
              ) : null}
              <CodeEditor
                className="min-h-0 flex-1"
                value={content}
                language="markdown"
                readOnly={current.readOnly}
                onSave={save}
                onChange={(v) => {
                  setContent(v)
                  setDirty(true)
                }}
              />
              {!current.enabled ? <p className="mt-2 text-xs text-muted-foreground">该 Skill 已禁用，Agent 不会加载。</p> : null}
            </>
          )}
        </div>
      </div>

      <Dialog open={creating} onOpenChange={setCreating}>
        {creating ? (
          <DialogContent
            title="新建 Skill"
            className="w-[440px]"
            footer={
              <>
                <Button variant="ghost" onClick={() => setCreating(false)}>
                  取消
                </Button>
                <Button variant="primary" disabled={!newName.trim()} onClick={create}>
                  创建
                </Button>
              </>
            }
          >
            <Field label="名称" hint="小写字母、数字和连字符，例如 weekly-report">
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus className="font-mono" placeholder="my-skill" />
            </Field>
          </DialogContent>
        ) : null}
      </Dialog>
      {sourcesOpen ? <SourcesDialog onClose={() => setSourcesOpen(false)} onChanged={list.reload} /> : null}
    </div>
  )
}
