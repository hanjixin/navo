import { Check, Copy, Eye, EyeOff, FolderSync, RotateCw, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { McpServerStatus } from '@shared/types'
import { PRODUCT_NAME } from '@/components/brand/logo'
import { Badge, StatusDot } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ErrorState, Skeleton } from '@/components/ui/states'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { call, on } from '@/lib/ipc'
import { cn, errorMessage, timeAgo } from '@/lib/utils'
import { useSettings } from '@/stores/settings'

type Client = 'claude-code' | 'cursor' | 'codex' | 'claude-desktop'

function snippet(client: Client, url: string, token: string): { lang: string; text: string; where: string } {
  switch (client) {
    case 'claude-code':
      return { where: '在终端执行', lang: 'sh', text: `claude mcp add --transport http navo ${url} --header "Authorization: Bearer ${token}"` }
    case 'cursor':
      return {
        where: '写入 ~/.cursor/mcp.json',
        lang: 'json',
        text: JSON.stringify({ mcpServers: { navo: { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
      }
    case 'codex':
      return {
        where: '写入 ~/.codex/config.toml',
        lang: 'toml',
        text: `[mcp_servers.navo]\nurl = "${url}"\nhttp_headers = { Authorization = "Bearer ${token}" }`,
      }
    case 'claude-desktop':
      return {
        where: '写入 claude_desktop_config.json（通过 mcp-remote 桥接）',
        lang: 'json',
        text: JSON.stringify(
          {
            mcpServers: {
              navo: { command: 'npx', args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${NAVO_AUTH}'], env: { NAVO_AUTH: `Bearer ${token}` } },
            },
          },
          null,
          2,
        ),
      }
  }
}

function CopyBlock({ text, masked }: { text: string; masked: string }) {
  const [done, setDone] = useState(false)
  return (
    <div className="group relative">
      <pre className="selectable overflow-x-auto rounded-md border border-border bg-muted px-3 py-2.5 pr-10 font-mono text-[11.5px] leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap">
        {masked}
      </pre>
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute top-1.5 right-1.5"
        aria-label="复制"
        onClick={() => {
          void navigator.clipboard.writeText(text)
          setDone(true)
          toast.success('已复制（包含 Token）')
          setTimeout(() => setDone(false), 1200)
        }}
      >
        {done ? <Check className="text-success" /> : <Copy />}
      </Button>
    </div>
  )
}

/** Navo as an MCP server for other agents on this computer. */
export function NavoMcpPanel() {
  const { settings, update } = useSettings()
  const cfg = settings!.mcpServer
  const [status, setStatus] = useState<McpServerStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [reveal, setReveal] = useState(false)
  const [port, setPort] = useState(String(cfg.port))
  useEffect(() => setPort(String(cfg.port)), [cfg.port])

  useEffect(() => {
    call('navoMcp.status').then(setStatus, (e) => setError(errorMessage(e)))
    return on('navoMcp.status', setStatus)
  }, [])
  useEffect(() => {
    if (cfg.enabled && !token) call('navoMcp.token').then(setToken, () => undefined)
  }, [cfg.enabled, token])

  const patch = (p: Partial<typeof cfg>) => update({ mcpServer: { ...cfg, ...p } }).catch((e) => toast.error('保存失败', { description: errorMessage(e) }))
  const url = status?.url ?? `http://127.0.0.1:${cfg.port}/mcp`
  const shown = token ? (reveal ? token : `${token.slice(0, 9)}${'•'.repeat(18)}`) : '…'
  const mask = (s: string) => (token && !reveal ? s.split(token).join(shown) : s)

  if (error) return <ErrorState error={error} />
  if (!status) return <Skeleton className="h-48" />

  return (
    <div className="grid gap-4">
      <Card className="divide-y divide-border">
        <div className="flex items-start justify-between gap-6 px-5 py-4">
          <div>
            <div className="text-sm font-medium">对外提供 MCP 服务</div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              让 Claude Code、Cursor、Codex 等本机 Agent 通过 MCP 管理 {PRODUCT_NAME} 的对话、模型、Skill、MCP 与连接器，并可把任务交给 {PRODUCT_NAME} 的 Agent
              执行。仅监听本机回环地址，需要 Token。
            </div>
          </div>
          <Switch checked={cfg.enabled} onCheckedChange={(v) => void patch({ enabled: v })} aria-label="启用 Navo MCP 服务" />
        </div>

        {cfg.enabled ? (
          <>
            <div className="grid gap-3 px-5 py-4">
              <div className="flex items-center gap-2 text-sm">
                <StatusDot status={status.running ? 'success' : status.error ? 'danger' : 'neutral'} />
                {status.running ? (
                  <span className="font-mono text-xs">{url}</span>
                ) : (
                  <span className="text-xs text-muted-foreground">{status.error ?? '正在启动…'}</span>
                )}
                <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                  端口
                  <Input
                    value={port}
                    onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
                    onBlur={() => Number(port) !== cfg.port && Number(port) > 1023 && void patch({ port: Number(port) })}
                    className="h-7 w-20 font-mono text-xs"
                  />
                </span>
              </div>
              <div className="flex items-center gap-2">
                <code className="selectable flex h-8 min-w-0 flex-1 items-center truncate rounded-md border border-border bg-muted px-2.5 font-mono text-xs">
                  {shown}
                </code>
                <Button variant="ghost" size="icon-sm" onClick={() => setReveal((v) => !v)} aria-label={reveal ? '隐藏 Token' : '显示 Token'}>
                  {reveal ? <EyeOff /> : <Eye />}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={async () => {
                    setToken(await call('navoMcp.regenerateToken'))
                    toast.success('已重新生成 Token', { description: '已连接的客户端需要更新配置' })
                  }}
                >
                  <RotateCw />
                  重新生成
                </Button>
              </div>
            </div>

            <div className="grid gap-3 px-5 py-4">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <ShieldCheck className="size-4 stroke-[1.75] text-brand" />
                权限
              </div>
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>
                  允许运行 {PRODUCT_NAME} Agent
                  <span className="block text-xs text-muted-foreground">
                    navo_send_message：外部 Agent 可以给 {PRODUCT_NAME} 派任务（会操作内置浏览器，需确认的操作仍由你在 {PRODUCT_NAME} 中批准）
                  </span>
                </span>
                <Switch checked={cfg.allowRun} onCheckedChange={(v) => void patch({ allowRun: v })} />
              </label>
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>
                  允许修改配置
                  <span className="block text-xs text-muted-foreground">
                    新建/修改/删除 Skill、MCP 服务器、连接器、对话，切换默认模型。关闭时只开放只读工具
                  </span>
                </span>
                <Switch checked={cfg.allowWrite} onCheckedChange={(v) => void patch({ allowWrite: v })} />
              </label>
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>
                  允许读取记忆
                  <span className="block text-xs text-muted-foreground">
                    memory_search / memory_daily：外部 Agent 可以读到 {PRODUCT_NAME} 记住的关于你的信息和每日日记。写入记忆还需要同时开启「允许修改配置」
                  </span>
                </span>
                <Switch checked={cfg.allowMemory} onCheckedChange={(v) => void patch({ allowMemory: v })} />
              </label>
              <p className="text-xs text-subtle-foreground">
                当前开放 {status.tools.length} 个工具（只读 {status.tools.filter((t) => t.readOnly).length} 个）。API Key 等密钥从不通过 MCP 返回。
              </p>
            </div>
          </>
        ) : null}
      </Card>

      {cfg.enabled && token ? (
        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium">接入其他 Agent</div>
              <div className="mt-0.5 text-xs text-muted-foreground">复制对应客户端的配置；或一键写入 .agents，供读取该目录的工具使用。</div>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={async () => {
                try {
                  const r = await call('navoMcp.installAgents')
                  toast.success('已写入 ~/.agents/mcp.json', { description: r.backup ? `原文件已备份为 ${r.backup.split('/').pop()}` : undefined })
                } catch (e) {
                  toast.error('写入失败', { description: errorMessage(e) })
                }
              }}
            >
              <FolderSync />
              写入 ~/.agents/mcp.json
            </Button>
          </div>
          <Tabs defaultValue="claude-code">
            <TabsList className="mb-3 w-full">
              <TabsTrigger value="claude-code">Claude Code</TabsTrigger>
              <TabsTrigger value="cursor">Cursor</TabsTrigger>
              <TabsTrigger value="codex">Codex</TabsTrigger>
              <TabsTrigger value="claude-desktop">Claude Desktop</TabsTrigger>
            </TabsList>
            {(['claude-code', 'cursor', 'codex', 'claude-desktop'] as Client[]).map((c) => {
              const s = snippet(c, url, token)
              return (
                <TabsContent key={c} value={c}>
                  <p className="mb-1.5 text-xs text-muted-foreground">{s.where}</p>
                  <CopyBlock text={s.text} masked={mask(s.text)} />
                </TabsContent>
              )
            })}
          </Tabs>
        </Card>
      ) : null}

      {cfg.enabled ? (
        <Card>
          <div className="border-b border-border px-5 py-3 text-sm font-medium">最近调用</div>
          {status.calls.length ? (
            <div className="divide-y divide-border">
              {status.calls.map((c, i) => (
                <div key={`${c.at}-${i}`} className="flex items-center gap-3 px-5 py-2 text-xs">
                  <Badge variant={c.ok ? 'success' : 'danger'} className="w-10 justify-center">
                    {c.ok ? '成功' : '失败'}
                  </Badge>
                  <span className="w-48 shrink-0 truncate font-mono">{c.tool}</span>
                  <span className={cn('min-w-0 flex-1 truncate', c.ok ? 'text-muted-foreground' : 'text-danger')}>{c.summary}</span>
                  <span className="shrink-0 text-subtle-foreground">
                    {c.ms} ms · {timeAgo(c.at)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="px-5 py-6 text-center text-xs text-muted-foreground">还没有外部 Agent 调用过</p>
          )}
        </Card>
      ) : null}
    </div>
  )
}
