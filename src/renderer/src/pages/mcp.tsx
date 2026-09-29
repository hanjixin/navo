import { Check, ChevronRight, FileJson, MoreHorizontal, Pencil, Plug, Plus, Radar, RotateCw, Server, Share2, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { DiscoveredMcp, McpServer, McpStatus, McpTransport } from '@shared/types'
import { Page, PageHeader } from '@/components/layout/page'
import { Badge, StatusDot } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { AsyncView, EmptyState, ListSkeleton } from '@/components/ui/states'
import { Switch } from '@/components/ui/switch'
import { useAsync } from '@/hooks/use-async'
import { NavoMcpPanel } from '@/components/mcp/navo-mcp-panel'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { call, on } from '@/lib/ipc'
import { cn, errorMessage } from '@/lib/utils'

type Draft = Omit<McpServer, 'id'> & { id?: string }

const kvToText = (o?: Record<string, string> | null) =>
  Object.entries(o ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
const textToKv = (t: string, sep = '=') =>
  Object.fromEntries(
    t
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const i = l.indexOf(sep)
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
      }),
  )

function ServerDialog({ server, onClose, onSaved }: { server: McpServer | null; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<Draft>(server ?? { name: '', transport: 'stdio', command: 'npx', args: [], env: null, url: '', headers: null, enabled: true })
  const [args, setArgs] = useState((server?.args ?? []).join('\n'))
  const [env, setEnv] = useState(kvToText(server?.env))
  const [headers, setHeaders] = useState(
    Object.entries(server?.headers ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n'),
  )
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      await call('mcp.save', {
        ...d,
        args: args
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        env: env.trim() ? textToKv(env) : null,
        headers: headers.trim() ? textToKv(headers, ':') : null,
      })
      toast.success('已保存，正在连接…')
      onSaved()
      onClose()
    } catch (e) {
      toast.error('保存失败', { description: errorMessage(e) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={server ? '编辑 MCP 服务器' : '添加 MCP 服务器'}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" loading={saving} onClick={save}>
              保存并连接
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <div className="grid grid-cols-[1fr_180px] gap-3">
            <Field label="名称">
              <Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="filesystem" autoFocus />
            </Field>
            <Field label="传输方式">
              <Select
                value={d.transport}
                onChange={(v) => setD({ ...d, transport: v as McpTransport })}
                options={[
                  { value: 'stdio', label: 'stdio（本地进程）' },
                  { value: 'http', label: 'Streamable HTTP' },
                  { value: 'sse', label: 'SSE' },
                ]}
              />
            </Field>
          </div>
          {d.transport === 'stdio' ? (
            <>
              <Field label="命令">
                <Input value={d.command ?? ''} onChange={(e) => setD({ ...d, command: e.target.value })} className="font-mono text-xs" placeholder="npx" />
              </Field>
              <Field label="参数" hint="每行一个">
                <Textarea
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  rows={3}
                  className="font-mono text-xs"
                  placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/Users/me/Documents'}
                />
              </Field>
              <Field label="环境变量" hint="每行 KEY=VALUE">
                <Textarea value={env} onChange={(e) => setEnv(e.target.value)} rows={2} className="font-mono text-xs" />
              </Field>
            </>
          ) : (
            <>
              <Field label="URL">
                <Input
                  value={d.url ?? ''}
                  onChange={(e) => setD({ ...d, url: e.target.value })}
                  className="font-mono text-xs"
                  placeholder="https://example.com/mcp"
                />
              </Field>
              <Field label="请求头" hint="每行 Header: value，例如 Authorization: Bearer xxx">
                <Textarea value={headers} onChange={(e) => setHeaders(e.target.value)} rows={2} className="font-mono text-xs" />
              </Field>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [json, setJson] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="从 JSON 导入"
        description="兼容 Claude Desktop / Cursor 的 mcpServers 配置格式。"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button
              variant="primary"
              loading={saving}
              onClick={async () => {
                setSaving(true)
                try {
                  const list = await call('mcp.importJson', json)
                  toast.success(`已导入 ${list.length} 个服务器`)
                  onDone()
                  onClose()
                } catch (e) {
                  setError(errorMessage(e))
                } finally {
                  setSaving(false)
                }
              }}
            >
              导入
            </Button>
          </>
        }
      >
        <Textarea
          value={json}
          onChange={(e) => {
            setJson(e.target.value)
            setError(null)
          }}
          rows={12}
          className="font-mono text-xs"
          placeholder={'{\n  "mcpServers": {\n    "fetch": { "command": "uvx", "args": ["mcp-server-fetch"] }\n  }\n}'}
        />
        {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
      </DialogContent>
    </Dialog>
  )
}

function describeEndpoint(d: Pick<DiscoveredMcp, 'transport' | 'command' | 'args' | 'url'>): string {
  return d.transport === 'stdio' ? `${d.command} ${(d.args ?? []).join(' ')}` : (d.url ?? '')
}

function DiscoverDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const found = useAsync(() => call('mcp.discover'))
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const groups = useMemo(() => {
    const m = new Map<string, DiscoveredMcp[]>()
    for (const d of found.data ?? []) m.set(d.sourceLabel, [...(m.get(d.sourceLabel) ?? []), d])
    return [...m.entries()]
  }, [found.data])
  const toggle = (k: string) =>
    setPicked((p) => {
      const n = new Set(p)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })
  const importable = (found.data ?? []).filter((d) => !d.imported)

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="扫描本机 MCP 配置"
        description="读取 ~/.agents/mcp.json、Claude Code、Claude Desktop、Cursor、Codex、Gemini CLI 与 VS Code 的配置。只会读取，不会修改它们。"
        className="w-[640px]"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button
              variant="primary"
              disabled={!picked.size}
              loading={saving}
              onClick={async () => {
                setSaving(true)
                try {
                  const list = await call('mcp.importDiscovered', [...picked])
                  toast.success(`已导入 ${list.length} 个服务器，正在连接…`)
                  onDone()
                  onClose()
                } catch (e) {
                  toast.error('导入失败', { description: errorMessage(e) })
                } finally {
                  setSaving(false)
                }
              }}
            >
              导入所选（{picked.size}）
            </Button>
          </>
        }
      >
        <AsyncView
          state={found}
          loading={<ListSkeleton rows={3} />}
          empty={<EmptyState icon={Radar} title="没有发现 MCP 配置" description="本机其他 Agent 工具中没有配置 MCP 服务器。" />}
        >
          {() => (
            <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
              {importable.length > 1 ? (
                <div className="flex justify-end">
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => setPicked(picked.size === importable.length ? new Set() : new Set(importable.map((d) => d.key)))}
                  >
                    {picked.size === importable.length ? '取消全选' : '全选可导入项'}
                  </Button>
                </div>
              ) : null}
              {groups.map(([label, items]) => (
                <div key={label}>
                  <div className="mb-1 flex items-baseline gap-2 px-1">
                    <span className="text-xs font-medium">{label}</span>
                    <span className="truncate font-mono text-[11px] text-subtle-foreground">{items[0].sourcePath}</span>
                  </div>
                  <div className="grid grid-cols-[minmax(0,1fr)] gap-1">
                    {items.map((d) => (
                      <label
                        key={d.key}
                        className={cn(
                          'interactive flex items-start gap-3 rounded-md border border-border px-3 py-2.5',
                          d.imported ? 'opacity-60' : 'cursor-pointer hover:bg-accent/50',
                          picked.has(d.key) && 'border-primary/40 bg-info-soft',
                        )}
                      >
                        <input
                          type="checkbox"
                          className="mt-1 accent-[var(--primary)]"
                          disabled={d.imported}
                          checked={picked.has(d.key)}
                          onChange={() => toggle(d.key)}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-sm font-medium">{d.name}</span>
                            <Badge variant="outline">{d.transport}</Badge>
                            {d.imported ? (
                              <Badge variant="success">
                                <Check />
                                已导入
                              </Badge>
                            ) : null}
                            {d.connectorId ? (
                              <Badge variant="primary">
                                <Plug />
                                有对应连接器
                              </Badge>
                            ) : null}
                          </div>
                          <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{describeEndpoint(d)}</div>
                          {d.env || d.headers ? (
                            <div className="mt-1 truncate text-[11px] text-subtle-foreground">
                              {d.env ? `环境变量: ${Object.keys(d.env).join(', ')}` : ''}
                              {d.env && d.headers ? ' · ' : ''}
                              {d.headers ? `请求头: ${Object.keys(d.headers).join(', ')}` : ''}
                            </div>
                          ) : null}
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </AsyncView>
      </DialogContent>
    </Dialog>
  )
}

function stateInfo(s?: McpStatus): { dot: 'success' | 'danger' | 'neutral' | 'running'; label: string } {
  switch (s?.state) {
    case 'connected':
      return { dot: 'success', label: `已连接 · ${s.tools.length} 个工具` }
    case 'connecting':
      return { dot: 'running', label: '连接中…' }
    case 'error':
      return { dot: 'danger', label: '连接失败' }
    default:
      return { dot: 'neutral', label: '未连接' }
  }
}

export function McpPage() {
  const servers = useAsync(() => call('mcp.list'))
  const [status, setStatus] = useState<Record<string, McpStatus>>({})
  const [editing, setEditing] = useState<McpServer | 'new' | null>(null)
  const [importing, setImporting] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [tab, setTab] = useState<'servers' | 'expose'>('servers')
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    const apply = (list: McpStatus[]) => setStatus(Object.fromEntries(list.map((s) => [s.id, s])))
    void call('mcp.status').then(apply)
    return on('mcp.status', apply)
  }, [])

  const toggle = async (s: McpServer, enabled: boolean) => {
    try {
      await call('mcp.save', { ...s, enabled })
      servers.reload()
    } catch (e) {
      toast.error('操作失败', { description: errorMessage(e) })
    }
  }

  return (
    <Page>
      <PageHeader
        title="MCP"
        description="连接 MCP 服务器为 Navo 扩展工具；也可以把 Navo 自身作为 MCP 服务提供给其他 Agent。"
        actions={
          tab === 'servers' && servers.data?.length ? (
            <>
              <Button variant="secondary" onClick={() => setDiscovering(true)}>
                <Radar />
                扫描本机
              </Button>
              <Button variant="secondary" onClick={() => setImporting(true)}>
                <FileJson />
                导入 JSON
              </Button>
              <Button variant="primary" onClick={() => setEditing('new')}>
                <Plus />
                添加服务器
              </Button>
            </>
          ) : null
        }
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as 'servers' | 'expose')}>
        <TabsList className="mb-4 w-full">
          <TabsTrigger value="servers">
            <Server />
            Navo 使用的服务器
          </TabsTrigger>
          <TabsTrigger value="expose">
            <Share2 />
            对外提供给其他 Agent
          </TabsTrigger>
        </TabsList>
        <TabsContent value="servers">
          <AsyncView
            state={servers}
            loading={<ListSkeleton rows={3} />}
            empty={
              <Card>
                <EmptyState
                  icon={Server}
                  title="还没有 MCP 服务器"
                  description="从 .agents、Claude Code、Cursor、Codex 等工具的配置中一键导入，或手动添加本地 stdio / 远程 HTTP 服务器。"
                  action={
                    <div className="flex gap-2">
                      <Button variant="primary" onClick={() => setDiscovering(true)}>
                        <Radar />
                        扫描本机
                      </Button>
                      <Button variant="secondary" onClick={() => setEditing('new')}>
                        手动添加
                      </Button>
                    </div>
                  }
                />
              </Card>
            }
          >
            {(list) => (
              <div className="grid gap-2">
                {list.map((s) => {
                  const st = status[s.id]
                  const info = stateInfo(s.enabled ? st : undefined)
                  const open = expanded === s.id
                  return (
                    <Card key={s.id} className="animate-fade-in">
                      <div className="flex items-center gap-3 px-4 py-3">
                        <button
                          onClick={() => setExpanded(open ? null : s.id)}
                          className="interactive -ml-1 rounded-sm p-1 text-subtle-foreground hover:text-foreground"
                          aria-label="展开"
                          disabled={!st?.tools.length}
                        >
                          <ChevronRight className={cn('size-3.5 transition-transform duration-150', open && 'rotate-90')} />
                        </button>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{s.name}</span>
                            <Badge variant="outline">{s.transport}</Badge>
                          </div>
                          <div className="truncate font-mono text-xs text-muted-foreground">
                            {s.transport === 'stdio' ? `${s.command} ${(s.args ?? []).join(' ')}` : s.url}
                          </div>
                        </div>
                        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <StatusDot status={info.dot} />
                          {info.label}
                        </span>
                        <Switch checked={s.enabled} onCheckedChange={(v) => void toggle(s, v)} aria-label="启用" />
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label="更多">
                              <MoreHorizontal />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => void call('mcp.reconnect', s.id)}>
                              <RotateCw />
                              重新连接
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => setEditing(s)}>
                              <Pencil />
                              编辑
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem danger onSelect={async () => (await call('mcp.delete', s.id), servers.reload())}>
                              <Trash2 />
                              删除
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      {st?.state === 'error' && s.enabled ? (
                        <div className="mx-4 mb-3 rounded-md border-l-2 border-l-danger bg-danger-soft px-3 py-2 font-mono text-xs break-all text-muted-foreground">
                          {st.error}
                        </div>
                      ) : null}
                      {open && st?.tools.length ? (
                        <div className="grid animate-fade-in gap-px border-t border-border px-4 py-2">
                          {st.tools.map((t) => (
                            <div key={t.name} className="flex gap-3 py-1.5 text-xs">
                              <span className="w-64 shrink-0 truncate font-mono font-medium">{t.name}</span>
                              <span className="line-clamp-2 text-muted-foreground">{t.description}</span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </Card>
                  )
                })}
              </div>
            )}
          </AsyncView>
        </TabsContent>
        <TabsContent value="expose">
          <NavoMcpPanel />
        </TabsContent>
      </Tabs>
      {editing ? <ServerDialog server={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={servers.reload} /> : null}
      {importing ? <ImportDialog onClose={() => setImporting(false)} onDone={servers.reload} /> : null}
      {discovering ? <DiscoverDialog onClose={() => setDiscovering(false)} onDone={servers.reload} /> : null}
    </Page>
  )
}
