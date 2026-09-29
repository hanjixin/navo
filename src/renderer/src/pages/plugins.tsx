import { FileCode2, FolderInput, Play, Plus, Puzzle, RotateCw, Save, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { PluginAction, PluginInfo } from '@shared/types'
import { CodeEditor } from '@/components/code-editor'
import { PageHeader } from '@/components/layout/page'
import { Badge, StatusDot } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Field, Input, Textarea } from '@/components/ui/input'
import { AsyncView, EmptyState, ErrorState, ListSkeleton, Skeleton } from '@/components/ui/states'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAsync } from '@/hooks/use-async'
import { call } from '@/lib/ipc'
import { cn, errorMessage } from '@/lib/utils'
import { useBrowser } from '@/stores/browser'

function exampleArgs(a: PluginAction): string {
  const props = (a.parameters as { properties?: Record<string, { type?: string }> }).properties ?? {}
  return JSON.stringify(Object.fromEntries(Object.entries(props).map(([k, v]) => [k, v.type === 'number' ? 1 : v.type === 'boolean' ? false : ''])), null, 2)
}

function ActionTester({ plugin, action, active }: { plugin: PluginInfo; action: PluginAction; active: boolean }) {
  const [args, setArgs] = useState(() => exampleArgs(action))
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [running, setRunning] = useState(false)
  const run = async () => {
    setRunning(true)
    setResult(null)
    try {
      const out = await call('plugins.runAction', plugin.id, action.name, JSON.parse(args || '{}'))
      setResult({ ok: true, text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) })
    } catch (e) {
      setResult({ ok: false, text: errorMessage(e) })
    } finally {
      setRunning(false)
    }
  }
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-sm font-medium">{action.name}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">{action.description}</p>
        </div>
        <Button variant="secondary" size="sm" loading={running} disabled={!active} onClick={run} title={active ? '' : '当前页面不匹配该插件'}>
          {!running ? <Play /> : null}
          在当前页运行
        </Button>
      </div>
      <Textarea value={args} onChange={(e) => setArgs(e.target.value)} rows={Math.min(6, args.split('\n').length)} className="mt-3 font-mono text-xs" />
      {result ? (
        <pre
          className={cn(
            'selectable mt-2 max-h-56 overflow-auto rounded-md px-3 py-2 font-mono text-xs whitespace-pre-wrap',
            result.ok ? 'bg-muted' : 'border-l-2 border-l-danger bg-danger-soft text-danger',
          )}
        >
          {result.text}
        </pre>
      ) : null}
    </Card>
  )
}

function FileEditor({ plugin, file, language, onSaved }: { plugin: PluginInfo; file: string; language: string; onSaved: () => void }) {
  const [content, setContent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    setContent(null)
    setError(null)
    setDirty(false)
    call('plugins.readFile', plugin.id, file).then(setContent, (e) => setError(errorMessage(e)))
  }, [plugin.id, file])
  const save = async () => {
    if (content == null) return
    setSaving(true)
    try {
      await call('plugins.writeFile', plugin.id, file, content)
      setDirty(false)
      toast.success(`已保存 ${file}，已重新注入匹配页面`)
      onSaved()
    } catch (e) {
      toast.error('保存失败', { description: errorMessage(e) })
    } finally {
      setSaving(false)
    }
  }
  if (error) return <ErrorState error={error} />
  if (content == null) return <Skeleton className="h-96" />
  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">{file}</span>
        {dirty ? <span className="text-xs text-warning">未保存</span> : null}
        <Button variant="primary" size="sm" className="ml-auto" loading={saving} disabled={!dirty} onClick={save}>
          {!saving ? <Save /> : null}
          保存
        </Button>
      </div>
      <CodeEditor
        className="min-h-0 flex-1"
        value={content}
        language={language}
        onSave={save}
        onChange={(v) => {
          setContent(v)
          setDirty(true)
        }}
      />
    </div>
  )
}

export function PluginsPage() {
  const list = useAsync(() => call('plugins.list'))
  const activeUrl = useBrowser((s) => s.state.tabs.find((t) => t.active)?.url)
  const activeIds = useAsync(() => call('plugins.activeForTab'), [activeUrl, list.data])
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ id: '', name: '' })

  useEffect(() => {
    if (!selected && list.data?.length) setSelected(list.data[0].id)
  }, [list.data, selected])

  const plugin = list.data?.find((p) => p.id === selected)
  const isActive = (id: string) => activeIds.data?.includes(id) ?? false

  const create = async () => {
    try {
      const p = await call('plugins.create', form.id.trim(), form.name.trim() || form.id.trim())
      setCreating(false)
      setForm({ id: '', name: '' })
      list.reload()
      setSelected(p.id)
    } catch (e) {
      toast.error('创建失败', { description: errorMessage(e) })
    }
  }

  return (
    <div className="@container flex h-full flex-col px-6 pt-6 pb-6 @4xl:px-8">
      <PageHeader
        title="站点插件"
        description="为特定网站注入 DOM 脚本并暴露动作。打开匹配的网站时，动作会作为 plugin_* 工具提供给 Agent，比逐步点击更快更稳。"
        actions={
          <>
            <Button variant="ghost" size="icon" onClick={async () => (await call('plugins.reload'), list.reload())} aria-label="重新加载">
              <RotateCw />
            </Button>
            <Button variant="secondary" onClick={async () => (await call('plugins.import'), list.reload())}>
              <FolderInput />
              导入
            </Button>
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus />
              新建插件
            </Button>
          </>
        }
      />
      <div className="flex min-h-0 flex-1 gap-4">
        <div className="w-52 shrink-0 overflow-y-auto @4xl:w-72">
          <AsyncView
            state={list}
            loading={<ListSkeleton rows={3} />}
            empty={
              <EmptyState
                icon={Puzzle}
                title="还没有插件"
                description="新建插件，为你常用的网站编写专属自动化动作。"
                action={
                  <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                    新建插件
                  </Button>
                }
              />
            }
          >
            {(plugins) => (
              <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
                {plugins.map((p) => (
                  <div
                    key={p.id}
                    onClick={() => setSelected(p.id)}
                    className={cn(
                      'card-hover cursor-default rounded-lg border bg-card px-3.5 py-3',
                      selected === p.id ? 'border-primary/40 ring-1 ring-primary/15' : 'border-border',
                    )}
                  >
                    <div className="flex items-center gap-2">
                      {isActive(p.id) ? <StatusDot status="success" /> : null}
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
                      <Switch
                        checked={p.enabled}
                        disabled={!!p.error}
                        onClick={(e) => e.stopPropagation()}
                        onCheckedChange={async (v) => (await call('plugins.setEnabled', p.id, v), list.reload())}
                        aria-label="启用"
                      />
                    </div>
                    <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{p.matches.join(', ') || p.id}</div>
                    {p.error ? (
                      <Badge variant="danger" className="mt-1.5">
                        配置错误
                      </Badge>
                    ) : (
                      <div className="mt-1.5 text-xs text-subtle-foreground">{p.actions.length} 个动作</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </AsyncView>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          {plugin ? (
            <Tabs defaultValue="overview" key={plugin.id} className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center gap-2">
                <TabsList className="flex-1">
                  <TabsTrigger value="overview">
                    <Puzzle />
                    概览
                  </TabsTrigger>
                  <TabsTrigger value="script">
                    <FileCode2 />
                    content.js
                  </TabsTrigger>
                  <TabsTrigger value="manifest">
                    <FileCode2 />
                    manifest.json
                  </TabsTrigger>
                </TabsList>
                <Button
                  variant="ghost"
                  size="sm"
                  className="hover:text-danger"
                  onClick={async () => (await call('plugins.delete', plugin.id), setSelected(null), list.reload())}
                >
                  <Trash2 />
                  删除
                </Button>
              </div>
              <TabsContent value="overview" className="min-h-0 flex-1 overflow-y-auto pt-4">
                {plugin.error ? <ErrorState error={plugin.error} compact className="mb-4" /> : null}
                <div className="mb-4 flex items-center gap-2 text-sm">
                  {isActive(plugin.id) ? <Badge variant="success">当前页面已匹配</Badge> : <Badge>当前页面未匹配</Badge>}
                  <span className="text-xs text-muted-foreground">{plugin.description}</span>
                </div>
                <div className="mb-2 text-xs font-medium text-subtle-foreground">匹配规则</div>
                <div className="mb-5 flex flex-wrap gap-1.5">
                  {plugin.matches.map((m) => (
                    <code key={m} className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs">
                      {m}
                    </code>
                  ))}
                </div>
                <div className="mb-2 text-xs font-medium text-subtle-foreground">动作</div>
                <div className="grid gap-2">
                  {plugin.actions.map((a) => (
                    <ActionTester key={a.name} plugin={plugin} action={a} active={isActive(plugin.id)} />
                  ))}
                </div>
              </TabsContent>
              <TabsContent value="script" className="min-h-0 flex-1 pt-4">
                <FileEditor plugin={plugin} file={plugin.contentScript} language="javascript" onSaved={list.reload} />
              </TabsContent>
              <TabsContent value="manifest" className="min-h-0 flex-1 pt-4">
                <FileEditor plugin={plugin} file="manifest.json" language="json" onSaved={list.reload} />
              </TabsContent>
            </Tabs>
          ) : null}
        </div>
      </div>

      <Dialog open={creating} onOpenChange={setCreating}>
        {creating ? (
          <DialogContent
            title="新建站点插件"
            className="w-[460px]"
            footer={
              <>
                <Button variant="ghost" onClick={() => setCreating(false)}>
                  取消
                </Button>
                <Button variant="primary" disabled={!form.id.trim()} onClick={create}>
                  创建
                </Button>
              </>
            }
          >
            <div className="grid gap-4">
              <Field label="插件 ID" hint="小写字母、数字和连字符，例如 taobao-helper">
                <Input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} autoFocus className="font-mono" />
              </Field>
              <Field label="显示名称">
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  )
}
