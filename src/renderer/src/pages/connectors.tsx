import {
  Bell,
  BookOpen,
  Boxes,
  Bug,
  CalendarDays,
  ExternalLink,
  GitBranch,
  Library,
  ListChecks,
  Mail,
  MessageCircle,
  Notebook,
  Plug,
  Plus,
  Radar,
  Send,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { ConnectorDef, ConnectorState, DiscoveredMcp } from '@shared/types'
import { FieldsDialog } from '@/components/connectors/fields-dialog'
import { Page, PageHeader, Section } from '@/components/layout/page'
import { Badge, StatusDot } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { ErrorState, Skeleton } from '@/components/ui/states'
import { Switch } from '@/components/ui/switch'
import { useAsync } from '@/hooks/use-async'
import { Tooltip } from '@/components/ui/tooltip'
import { call, on } from '@/lib/ipc'
import { errorMessage, timeAgo } from '@/lib/utils'
import { t } from '@shared/i18n'

const ICONS: Record<string, LucideIcon> = {
  github: GitBranch,
  notebook: Notebook,
  'list-checks': ListChecks,
  bug: Bug,
  boxes: Boxes,
  'book-open': BookOpen,
  library: Library,
  plug: Plug,
  feishu: Send,
  dingtalk: Bell,
  wecom: MessageCircle,
  mail: Mail,
  calendar: CalendarDays,
}

function TokenDialog({ def, onClose, onDone }: { def: ConnectorDef; onClose: () => void; onDone: () => void }) {
  const [token, setToken] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={t('连接 {{v0}}', { v0: def.name })}
        className="w-[460px]"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('取消')}
            </Button>
            <Button
              variant="primary"
              loading={pending}
              disabled={!token.trim()}
              onClick={async () => {
                setPending(true)
                setError(null)
                try {
                  await call('connectors.connect', def.id, token.trim())
                  toast.success(t('已连接 {{v0}}', { v0: def.name }))
                  onDone()
                  onClose()
                } catch (e) {
                  setError(errorMessage(e))
                } finally {
                  setPending(false)
                }
              }}
            >
              {t('连接')}
            </Button>
          </>
        }
      >
        <Field
          label={def.tokenLabel ?? 'Token'}
          error={error ?? undefined}
          hint={
            def.tokenHelp ? (
              <Button variant="link" size="sm" className="text-xs" onClick={() => void call('app.openExternal', def.tokenHelp!)}>
                {t('获取 Token')}
                <ExternalLink className="size-3" />
              </Button>
            ) : undefined
          }
        >
          <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoFocus className="font-mono text-xs" />
        </Field>
      </DialogContent>
    </Dialog>
  )
}

function CustomDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [mcpUrl, setUrl] = useState('')
  const [auth, setAuth] = useState<ConnectorDef['auth']>('oauth')
  const [pending, setPending] = useState(false)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={t('添加自定义连接器')}
        description={t('连接任何支持 MCP 的远程服务。OAuth 使用 MCP 授权规范（自动注册客户端）。')}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('取消')}
            </Button>
            <Button
              variant="primary"
              loading={pending}
              disabled={!name.trim() || !mcpUrl.trim()}
              onClick={async () => {
                setPending(true)
                try {
                  await call('connectors.addCustom', { name, description, mcpUrl, auth, tokenLabel: 'Bearer Token' })
                  onDone()
                  onClose()
                } catch (e) {
                  toast.error(t('添加失败'), { description: errorMessage(e) })
                } finally {
                  setPending(false)
                }
              }}
            >
              {t('添加')}
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <Field label={t('名称')}>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label={t('说明')}>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label={t('MCP 地址')}>
            <Input value={mcpUrl} onChange={(e) => setUrl(e.target.value)} className="font-mono text-xs" placeholder="https://example.com/mcp" />
          </Field>
          <Field label={t('认证方式')}>
            <Select
              value={auth}
              onChange={(v) => setAuth(v as ConnectorDef['auth'])}
              options={[
                { value: 'oauth', label: 'OAuth' },
                { value: 'token', label: 'Bearer Token' },
                { value: 'none', label: t('无需认证') },
              ]}
            />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ConnectorCard({
  def,
  state,
  reload,
  onToken,
  onFields,
  usedIn,
}: {
  def: ConnectorDef
  state?: ConnectorState
  reload: () => void
  onToken: () => void
  onFields: () => void
  usedIn?: string[]
}) {
  const [pending, setPending] = useState(false)
  const [testing, setTesting] = useState(false)
  const Icon = ICONS[def.icon] ?? Plug

  const test = async () => {
    setTesting(true)
    try {
      await call('connectors.testNotify', def.id)
      toast.success(t('测试消息已发送'))
    } catch (e) {
      toast.error(t('发送失败'), { description: errorMessage(e) })
    } finally {
      setTesting(false)
    }
  }

  const connect = async () => {
    if (def.auth === 'fields') return onFields()
    if (def.auth === 'token') return onToken()
    setPending(true)
    if (def.auth === 'oauth') toast(t('已在浏览器中打开授权页面'), { description: t('完成授权后会自动返回') })
    try {
      await call('connectors.connect', def.id)
      toast.success(t('已连接 {{v0}}', { v0: def.name }))
    } catch (e) {
      toast.error(t('连接 {{v0}} 失败', { v0: def.name }), { description: errorMessage(e) })
    } finally {
      setPending(false)
      reload()
    }
  }

  return (
    <Card className="card-hover flex flex-col p-4">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-background">
          <Icon className="size-4.5 stroke-[1.5]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{def.name}</span>
            {def.custom ? <Badge variant="outline">{t('自定义')}</Badge> : null}
            {usedIn?.length && !state?.connected ? (
              <Tooltip content={t('已在 {{v0}} 中配置', { v0: usedIn.join('、') })}>
                <Badge variant="primary">
                  <Radar />
                  {t('本机已在用')}
                </Badge>
              </Tooltip>
            ) : null}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{def.description}</p>
        </div>
        {state?.connected ? (
          <Switch checked={state.enabled} onCheckedChange={async (v) => (await call('connectors.setEnabled', def.id, v), reload())} aria-label={t('启用')} />
        ) : null}
      </div>
      {state?.error && !pending ? (
        <p className="mt-3 line-clamp-2 text-xs text-danger" title={state.error}>
          {state.error}
        </p>
      ) : null}
      <div className="mt-4 flex items-center gap-2">
        {state?.connected ? (
          <>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <StatusDot status={state.enabled ? 'success' : 'neutral'} />
              {state.enabled ? t('已连接') : t('已暂停')}
              {state.connectedAt ? ` · ${timeAgo(state.connectedAt)}` : ''}
            </span>
            <span className="ml-auto flex gap-1">
              {def.canNotify ? (
                <Button variant="ghost" size="sm" loading={testing} onClick={() => void test()}>
                  {t('测试')}
                </Button>
              ) : null}
              {def.auth === 'fields' ? (
                <Button variant="ghost" size="sm" onClick={onFields}>
                  {t('修改')}
                </Button>
              ) : null}
              <Button variant="ghost" size="sm" onClick={async () => (await call('connectors.disconnect', def.id), reload())}>
                {t('断开')}
              </Button>
            </span>
          </>
        ) : (
          <>
            <span className="text-xs text-subtle-foreground">
              {def.auth === 'oauth'
                ? t('OAuth 授权')
                : def.auth === 'token'
                  ? t('需要 Token')
                  : def.auth === 'fields'
                    ? def.kind === 'stdio'
                      ? t('官方 MCP · 填写应用凭证')
                      : t('填写配置')
                    : t('无需认证')}
            </span>
            <Button variant="secondary" size="sm" className="ml-auto" loading={pending} onClick={connect}>
              {pending && def.auth === 'oauth' ? t('等待授权…') : t('连接')}
            </Button>
          </>
        )}
      </div>
    </Card>
  )
}

export function ConnectorsPage() {
  const data = useAsync(async () => {
    const [catalog, states, discovered] = await Promise.all([
      call('connectors.catalog'),
      call('connectors.states'),
      call('mcp.discover').catch(() => [] as DiscoveredMcp[]),
    ])
    return { catalog, states: Object.fromEntries(states.map((s) => [s.id, s])), discovered: discovered.filter((d) => d.transport !== 'stdio') }
  })
  const [tokenFor, setTokenFor] = useState<ConnectorDef | null>(null)
  const [fieldsFor, setFieldsFor] = useState<ConnectorDef | null>(null)
  const [custom, setCustom] = useState(false)

  const reload = data.reload
  useEffect(() => on('connectors.changed', () => reload()), [reload])

  const usedIn = (id: string) => [...new Set((data.data?.discovered ?? []).filter((d) => d.connectorId === id).map((d) => d.sourceLabel.split(' · ')[0]))]
  const customUrls = new Set((data.data?.catalog ?? []).map((c) => c.mcpUrl?.replace(/\/+$/, '')))
  const unmatched = (data.data?.discovered ?? []).filter((d) => !d.connectorId && !customUrls.has(d.url?.replace(/\/+$/, '')))

  const addDiscovered = async (d: DiscoveredMcp) => {
    const bearer = Object.entries(d.headers ?? {})
      .find(([k]) => k.toLowerCase() === 'authorization')?.[1]
      ?.replace(/^Bearer\s+/i, '')
    try {
      const def = await call('connectors.addCustom', {
        name: d.name,
        description: t('从 {{v0}} 发现', { v0: d.sourceLabel }),
        mcpUrl: d.url!,
        auth: bearer ? 'token' : 'none',
        tokenLabel: 'Bearer Token',
      })
      await call('connectors.connect', def.id, bearer)
      toast.success(t('已添加并连接 {{v0}}', { v0: d.name }))
    } catch (e) {
      toast.error(t('添加 {{v0}} 失败', { v0: d.name }), { description: errorMessage(e) })
    } finally {
      data.reload()
    }
  }

  const connected = data.data?.catalog.filter((d) => data.data!.states[d.id]?.connected) ?? []
  const available = data.data?.catalog.filter((d) => !data.data!.states[d.id]?.connected) ?? []
  const office = available.filter((d) => d.group === 'office-cn')
  const others = available.filter((d) => d.group !== 'office-cn')
  const card = (d: ConnectorDef) => (
    <ConnectorCard
      key={d.id}
      def={d}
      state={data.data!.states[d.id]}
      reload={data.reload}
      onToken={() => setTokenFor(d)}
      onFields={() => setFieldsFor(d)}
      usedIn={usedIn(d.id)}
    />
  )

  return (
    <Page wide>
      <PageHeader
        title={t('连接器')}
        description={t('把常用服务接入 Agent：远程 MCP、官方本地 MCP，以及群机器人、邮箱、日历。凭据加密保存在本机。')}
        actions={
          <Button variant="primary" onClick={() => setCustom(true)}>
            <Plus />
            {t('自定义连接器')}
          </Button>
        }
      />
      {data.error && !data.data ? (
        <ErrorState error={data.error} onRetry={data.reload} />
      ) : !data.data ? (
        <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i} className="grid gap-3 p-4">
              <div className="flex gap-3">
                <Skeleton className="size-9 rounded-md" />
                <div className="grid flex-1 gap-2">
                  <Skeleton className="h-3.5 w-1/3" />
                  <Skeleton className="h-3 w-4/5" />
                </div>
              </div>
              <Skeleton className="h-7 w-full" />
            </Card>
          ))}
        </div>
      ) : (
        <>
          {connected.length ? (
            <Section title={t('已连接')} description={t('{{v0}} 个连接器的工具已提供给 Agent', { v0: connected.length })}>
              <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">
                {connected.map((d) => (
                  <ConnectorCard
                    key={d.id}
                    def={d}
                    state={data.data!.states[d.id]}
                    reload={data.reload}
                    onToken={() => setTokenFor(d)}
                    onFields={() => setFieldsFor(d)}
                    usedIn={usedIn(d.id)}
                  />
                ))}
              </div>
            </Section>
          ) : null}
          {unmatched.length ? (
            <Section title={t('在本机发现')} description={t('其他 Agent 工具（.agents、Claude Code、Cursor 等）中配置的远程 MCP 服务，可直接添加为连接器')}>
              <Card className="divide-y divide-border">
                {unmatched.map((d) => (
                  <div key={d.key} className="flex items-center gap-3 px-4 py-3">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background">
                      <Radar className="size-4 stroke-[1.5] text-muted-foreground" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        {d.name}
                        <Badge variant="outline">{d.sourceLabel}</Badge>
                      </div>
                      <div className="truncate font-mono text-xs text-muted-foreground">{d.url}</div>
                    </div>
                    <Button variant="secondary" size="sm" onClick={() => void addDiscovered(d)}>
                      {t('添加')}
                    </Button>
                  </div>
                ))}
              </Card>
            </Section>
          ) : null}
          {office.length ? (
            <Section title={t('国内办公')} description={t('飞书、钉钉的官方 MCP，群机器人、邮箱和日历')}>
              <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">{office.map(card)}</div>
            </Section>
          ) : null}
          <Section title={t('可用连接器')}>
            <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2 @4xl:grid-cols-3">{others.map(card)}</div>
          </Section>
        </>
      )}
      {fieldsFor ? <FieldsDialog def={fieldsFor} state={data.data?.states[fieldsFor.id]} onClose={() => setFieldsFor(null)} onDone={data.reload} /> : null}
      {tokenFor ? <TokenDialog def={tokenFor} onClose={() => setTokenFor(null)} onDone={data.reload} /> : null}
      {custom ? <CustomDialog onClose={() => setCustom(false)} onDone={data.reload} /> : null}
    </Page>
  )
}
