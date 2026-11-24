import { Bot, MoreHorizontal, Pencil, Play, Plug, Plus, Puzzle, Server, Sparkles, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import type {
  AgentInfrastructure,
  AgentProfile,
  AgentProfileInput,
  ConnectorDef,
  ConnectorState,
  McpServer,
  ModelConfig,
  PluginInfo,
  Skill,
} from '@shared/types'
import type { AgentRuntimeInfo } from '@shared/agent-runtime'
import { Page, PageHeader } from '@/components/layout/page'
import { SYSTEM_AGENT_ID } from '@shared/agent-templates'
import { TeamTemplatePicker } from '@/components/agents/team-template-picker'
import { Badge, StatusDot } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CardGrid } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { EmptyState, ErrorState, ListSkeleton } from '@/components/ui/states'
import { call } from '@/lib/ipc'
import { threadPath } from '@/lib/routes'
import { errorMessage, timeAgo } from '@/lib/utils'
import { useAgents } from '@/stores/agents'
import { t } from '@shared/i18n'

interface Resources {
  runtimes: AgentRuntimeInfo[]
  models: ModelConfig[]
  skills: Skill[]
  mcps: McpServer[]
  connectors: { def: ConnectorDef; state: ConnectorState }[]
  plugins: PluginInfo[]
}

const emptyInfrastructure = (): AgentInfrastructure => ({ skillIds: [], mcpServerIds: [], connectorIds: [], pluginIds: [] })
const emptyDraft = (resources?: Resources): AgentProfileInput => ({
  name: '',
  description: '',
  instructions: '',
  runtimeId: resources?.runtimes.find((item) => item.profile.enabled)?.profile.id ?? 'builtin',
  modelId: resources?.models.find((model) => model.enabled && model.isDefault)?.id ?? resources?.models.find((model) => model.enabled)?.id ?? null,
  infrastructure: emptyInfrastructure(),
})

function ResourceGroup({
  title,
  icon: Icon,
  items,
  selected,
  onChange,
}: {
  title: string
  icon: typeof Sparkles
  items: { id: string; name: string; detail?: string; available: boolean }[]
  selected: string[]
  onChange: (ids: string[]) => void
}) {
  const chosen = new Set(selected)
  return (
    <section>
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <Icon className="size-4 text-muted-foreground" />
        {title}
        <Badge variant="neutral">{selected.length}</Badge>
      </div>
      {items.length ? (
        <div className="max-h-40 overflow-y-auto rounded-md border border-border">
          {items.map((item) => (
            <label key={item.id} className="interactive flex min-h-10 items-center gap-3 border-b border-border px-3 py-2 last:border-b-0 hover:bg-accent">
              <Checkbox
                checked={chosen.has(item.id)}
                disabled={!item.available && !chosen.has(item.id)}
                onCheckedChange={(checked) => onChange(checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{item.name}</span>
                {item.detail ? <span className="block truncate text-xs text-muted-foreground">{item.detail}</span> : null}
              </span>
              <StatusDot status={item.available ? 'success' : 'neutral'} />
            </label>
          ))}
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">{t('暂无可绑定资源')}</p>
      )}
    </section>
  )
}

function AgentEditor({ agent, resources, onClose }: { agent?: AgentProfile; resources: Resources; onClose: () => void }) {
  const save = useAgents((state) => state.save)
  const [draft, setDraft] = useState<AgentProfileInput>(() => (agent ? { ...agent, infrastructure: { ...agent.infrastructure } } : emptyDraft(resources)))
  const initialDraft = useRef(JSON.stringify(draft)).current
  const dirty = JSON.stringify(draft) !== initialDraft
  const [saving, setSaving] = useState(false)
  const runtime = resources.runtimes.find((item) => item.profile.id === draft.runtimeId)
  const needsModel = runtime?.capabilities.requiresNavoModel ?? runtime?.capabilities.navoTools ?? true
  const runtimeUnavailable = !runtime?.profile.enabled
  const selectedModel = resources.models.find((model) => model.id === draft.modelId)
  const modelUnavailable = needsModel && (!selectedModel || !selectedModel.enabled)
  const setInfrastructure = <K extends keyof AgentInfrastructure>(key: K, value: AgentInfrastructure[K]) =>
    setDraft((current) => ({ ...current, infrastructure: { ...current.infrastructure, [key]: value } }))
  const submit = async () => {
    setSaving(true)
    try {
      await save({ ...draft, modelId: needsModel ? draft.modelId : null })
      toast.success(agent ? t('智能体已更新') : t('智能体已创建'))
      onClose()
    } catch (error) {
      toast.error(t('保存失败'), { description: errorMessage(error) })
    } finally {
      setSaving(false)
    }
  }
  const requestClose = () => {
    if (saving) return
    if (dirty && !window.confirm(t('放弃未保存的修改？'))) return
    onClose()
  }
  const connected = new Map(resources.connectors.map((item) => [item.def.id, item.state]))
  return (
    <Dialog open onOpenChange={(open) => !open && requestClose()}>
      <DialogContent
        title={agent ? t('编辑智能体') : t('新建智能体')}
        description={t('为智能体固定执行方式，并只绑定它需要的基础设施。')}
        className="w-[min(760px,calc(100vw-48px))]"
        footer={
          <>
            <Button variant="ghost" onClick={requestClose}>
              {t('取消')}
            </Button>
            <Button variant="primary" loading={saving} disabled={!draft.name.trim() || runtimeUnavailable || modelUnavailable} onClick={submit}>
              {t('保存')}
            </Button>
          </>
        }
      >
        <div className="grid gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('名称')}>
              <Input
                value={draft.name}
                maxLength={120}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                placeholder={t('例如：研发助手')}
              />
            </Field>
            <Field label={t('简介')}>
              <Input
                value={draft.description ?? ''}
                maxLength={1000}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                placeholder={t('一句话说明职责')}
              />
            </Field>
          </div>
          <Field label={t('执行指令')} hint={t('每次运行都会加入系统提示。')}>
            <Textarea
              rows={5}
              value={draft.instructions ?? ''}
              onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
              placeholder={t('说明目标、边界、工作方式和交付标准')}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('运行时')} hint={runtimeUnavailable ? t('请选择已启用的运行时') : undefined}>
              <Select
                value={draft.runtimeId}
                onChange={(runtimeId) => {
                  const next = resources.runtimes.find((item) => item.profile.id === runtimeId)
                  const modelId =
                    (next?.capabilities.requiresNavoModel ?? next?.capabilities.navoTools)
                      ? (draft.modelId ?? resources.models.find((model) => model.enabled)?.id ?? null)
                      : null
                  setDraft({ ...draft, runtimeId, modelId })
                }}
                options={resources.runtimes
                  .filter((item) => item.profile.enabled || item.profile.id === draft.runtimeId)
                  .map((item) => ({
                    value: item.profile.id,
                    label: item.profile.name,
                    hint: item.profile.enabled ? undefined : t('未启用'),
                  }))}
              />
            </Field>
            <Field label={t('模型')} hint={!needsModel ? t('由运行时自身配置') : modelUnavailable ? t('请选择已启用的模型') : undefined}>
              <Select
                value={draft.modelId ?? undefined}
                placeholder={needsModel ? t('默认模型') : t('由运行时自身配置')}
                disabled={!needsModel}
                onChange={(modelId) => setDraft({ ...draft, modelId })}
                options={resources.models
                  .filter((model) => model.enabled || model.id === draft.modelId)
                  .map((model) => ({ value: model.id, label: model.displayName, hint: model.enabled ? undefined : t('未启用') }))}
              />
            </Field>
          </div>
          <div className="border-t border-border pt-5">
            <h3 className="text-sm font-semibold">{t('绑定基础设施')}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('未选择的资源不会暴露给这个智能体。')}</p>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <ResourceGroup
              title="Skill"
              icon={Sparkles}
              selected={draft.infrastructure.skillIds}
              onChange={(value) => setInfrastructure('skillIds', value)}
              items={resources.skills
                .filter((item) => !item.shadowed)
                .map((item) => ({ id: item.id, name: item.name, detail: item.description, available: item.enabled }))}
            />
            <ResourceGroup
              title="MCP"
              icon={Server}
              selected={draft.infrastructure.mcpServerIds}
              onChange={(value) => setInfrastructure('mcpServerIds', value)}
              items={resources.mcps.map((item) => ({
                id: item.id,
                name: item.name,
                detail: item.transport === 'stdio' ? (item.command ?? '') : (item.url ?? ''),
                available: item.enabled,
              }))}
            />
            <ResourceGroup
              title={t('连接器')}
              icon={Plug}
              selected={draft.infrastructure.connectorIds}
              onChange={(value) => setInfrastructure('connectorIds', value)}
              items={resources.connectors.map(({ def }) => ({
                id: def.id,
                name: def.name,
                detail: def.description,
                available: !!connected.get(def.id)?.connected && connected.get(def.id)?.enabled !== false,
              }))}
            />
            <ResourceGroup
              title={t('站点插件')}
              icon={Puzzle}
              selected={draft.infrastructure.pluginIds}
              onChange={(value) => setInfrastructure('pluginIds', value)}
              items={resources.plugins.map((item) => ({
                id: item.id,
                name: item.name,
                detail: item.matches.join(', '),
                available: item.enabled && !item.error,
              }))}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function AgentsPage() {
  const { agents, error, load, remove } = useAgents()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<AgentProfile | 'new' | null>(null)
  const [deleting, setDeleting] = useState<AgentProfile | null>(null)
  const [deletingAgent, setDeletingAgent] = useState(false)
  const [resources, setResources] = useState<Resources | null>(null)
  const [resourceError, setResourceError] = useState<string | null>(null)
  const loadResources = async () => {
    try {
      const [runtimes, models, skills, mcps, connectorDefs, connectorStates, plugins] = await Promise.all([
        call('runtimes.list'),
        call('models.list'),
        call('skills.list'),
        call('mcp.list'),
        call('connectors.catalog'),
        call('connectors.states'),
        call('plugins.list'),
      ])
      const states = new Map(connectorStates.map((state) => [state.id, state]))
      setResources({
        runtimes,
        models,
        skills,
        mcps,
        connectors: connectorDefs.map((def) => ({ def, state: states.get(def.id) ?? { id: def.id, connected: false, enabled: true } })),
        plugins,
      })
      setResourceError(null)
    } catch (loadError) {
      setResourceError(errorMessage(loadError))
    }
  }
  useEffect(() => {
    void load()
    void loadResources()
  }, [load])
  const matches = useMemo(() => {
    const text = query.trim().toLowerCase()
    return agents?.filter((agent) => !text || `${agent.name} ${agent.description}`.toLowerCase().includes(text))
  }, [agents, query])
  const start = async (agent: AgentProfile) => {
    try {
      const thread = await call('agents.start', agent.id)
      navigate(threadPath(thread))
    } catch (startError) {
      toast.error(t('启动失败'), {
        description: errorMessage(startError),
        action: agent.runtimeId === 'builtin' ? { label: t('管理模型'), onClick: () => navigate('/models') } : undefined,
      })
    }
  }
  return (
    <Page wide>
      <PageHeader
        title={t('智能体')}
        count={agents?.length}
        search={{ label: t('搜索智能体'), value: query, onChange: setQuery }}
        more={[{ label: t('新建智能体'), icon: Plus, run: () => setEditing('new'), disabled: !resources }]}
        description={t('创建职责明确的智能体，并为每个智能体绑定独立的模型、Skill、MCP、连接器和插件。')}
        actions={
          <TeamTemplatePicker
            agents={agents}
            resourceName={(kind, id) =>
              kind === 'connector'
                ? (resources?.connectors.find(({ def }) => def.id === id)?.def.name ?? id)
                : (resources?.plugins.find((item) => item.id === id)?.name ?? id)
            }
            onAdded={async () => {
              setQuery('')
              await load()
            }}
          />
        }
      />
      <section aria-label={t('我的智能体')}>
        {error ? <ErrorState error={error} onRetry={() => void load()} className="mb-4" /> : null}
        {resourceError ? <ErrorState error={resourceError} onRetry={() => void loadResources()} className="mb-4" /> : null}
        {!agents ? (
          <ListSkeleton />
        ) : !matches?.length ? (
          <EmptyState
            icon={Bot}
            title={query ? t('没有匹配的智能体') : t('暂无智能体')}
            description={!query ? t('创建智能体，并按职责为它配置专属基础设施。') : undefined}
            action={!query && resources ? <Button onClick={() => setEditing('new')}>{t('创建智能体')}</Button> : undefined}
          />
        ) : (
          <CardGrid className="items-stretch">
            {matches.map((agent) => {
              const runtime = resources?.runtimes.find((item) => item.profile.id === agent.runtimeId)?.profile.name ?? agent.runtimeId
              const model = resources?.models.find((item) => item.id === agent.modelId)?.displayName
              const count = Object.values(agent.infrastructure).reduce((sum, ids) => sum + ids.length, 0)
              return (
                <article key={agent.id} className="flex min-w-0 flex-col rounded-lg border border-border bg-card p-3">
                  <div className="flex items-start gap-2">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-info-soft text-brand">
                      <Bot className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2">
                        <h2 className="max-w-full truncate text-sm font-semibold" title={agent.name}>
                          {agent.name}
                        </h2>
                        {agent.id === SYSTEM_AGENT_ID ? <Badge variant="primary">{t('系统内置')}</Badge> : null}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs break-words text-muted-foreground" title={agent.description}>
                        {agent.description || t('暂无智能体说明')}
                      </p>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={`${t('更多')} · ${agent.name}`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setEditing(agent)}>
                          <Pencil />
                          {t('编辑智能体')}
                        </DropdownMenuItem>
                        {agent.id !== SYSTEM_AGENT_ID ? (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem danger onSelect={() => setDeleting(agent)}>
                              <Trash2 />
                              {t('删除智能体')}
                            </DropdownMenuItem>
                          </>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span className="max-w-full truncate" title={runtime}>
                      {runtime}
                    </span>
                    <span className="max-w-full truncate" title={model ?? undefined}>
                      {model ?? (agent.runtimeId === 'builtin' && !agent.modelId ? t('默认模型') : agent.modelId)}
                    </span>
                  </div>
                  <div className="mt-auto flex items-center justify-between gap-2 pt-2">
                    <span className="text-xs text-muted-foreground" title={agent.updatedAt ? t('更新于 {{v0}}', { v0: timeAgo(agent.updatedAt) }) : undefined}>
                      {t('{{count}} 个绑定', { count })}
                    </span>
                    <Button size="sm" onClick={() => void start(agent)}>
                      <Play />
                      {t('开始对话')}
                    </Button>
                  </div>
                </article>
              )
            })}
          </CardGrid>
        )}
      </section>
      {editing && resources ? <AgentEditor agent={editing === 'new' ? undefined : editing} resources={resources} onClose={() => setEditing(null)} /> : null}
      {deleting ? (
        <Dialog open onOpenChange={(open) => !open && setDeleting(null)}>
          <DialogContent
            title={t('删除智能体')}
            description={t('已有对话会保留创建时的智能体配置。')}
            footer={
              <>
                <Button variant="ghost" onClick={() => setDeleting(null)}>
                  {t('取消')}
                </Button>
                <Button
                  variant="danger"
                  loading={deletingAgent}
                  onClick={async () => {
                    setDeletingAgent(true)
                    try {
                      await remove(deleting.id)
                      setDeleting(null)
                    } catch (error) {
                      toast.error(t('操作失败'), { description: errorMessage(error) })
                    } finally {
                      setDeletingAgent(false)
                    }
                  }}
                >
                  {t('删除')}
                </Button>
              </>
            }
          >
            <p className="text-sm">{t('确定删除智能体「{{v0}}」吗？', { v0: deleting.name })}</p>
          </DialogContent>
        </Dialog>
      ) : null}
    </Page>
  )
}
