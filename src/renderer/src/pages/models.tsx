import {
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Coins,
  Cpu,
  Download,
  ExternalLink,
  KeyRound,
  MoreHorizontal,
  Pencil,
  Plus,
  Star,
  Trash2,
  Zap,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import type { ModelConfig, ModelInput, Provider, ProviderInput, ProviderType } from '@shared/types'
import { CURRENCY_SYMBOL } from '@shared/pricing'
import { Page, PageHeader } from '@/components/layout/page'
import { ModelIdInput } from '@/components/models/model-id-input'
import { PricingDialog } from '@/components/models/pricing-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { EmptyState, ErrorState, ListSkeleton } from '@/components/ui/states'
import { Switch } from '@/components/ui/switch'
import { call } from '@/lib/ipc'
import { cn, errorMessage } from '@/lib/utils'
import { useModels } from '@/stores/models'
import { guessVision, PRESETS, presetFor, type Preset } from '@/lib/providers'
import { t } from '@shared/i18n'

const TYPES: { value: ProviderType; label: string; hint: string; baseURL: string }[] = [
  { value: 'anthropic', label: 'Anthropic', hint: t('Claude 系列，Messages API'), baseURL: 'https://api.anthropic.com' },
  { value: 'openai', label: 'OpenAI · Chat Completions', hint: '/v1/chat/completions', baseURL: 'https://api.openai.com/v1' },
  { value: 'openai-responses', label: 'OpenAI · Responses', hint: t('/v1/responses，支持推理与内置工具'), baseURL: 'https://api.openai.com/v1' },
  { value: 'openai-compatible', label: t('OpenAI 兼容接口'), hint: t('DeepSeek、通义千问、Ollama、vLLM 等'), baseURL: 'http://localhost:11434/v1' },
]
const typeLabel = (t: ProviderType) => TYPES.find((x) => x.value === t)?.label ?? t

function ProviderDialog({ provider, onClose, onSaved }: { provider: Provider | 'new'; onClose: () => void; onSaved: (p: Provider, isNew: boolean) => void }) {
  const editing = provider !== 'new' ? provider : null
  const [type, setType] = useState<ProviderType>(editing?.type ?? 'anthropic')
  const [name, setName] = useState(editing?.name ?? '')
  const [baseURL, setBaseURL] = useState(editing?.baseURL ?? '')
  const [apiKey, setApiKey] = useState('')
  const [headers, setHeaders] = useState(editing?.headers ? JSON.stringify(editing.headers, null, 2) : '')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const meta = TYPES.find((t) => t.value === type)!
  const [preset, setPreset] = useState<Preset | null>(null)
  const applyPreset = (x: Preset) => {
    setPreset(x)
    setType(x.type)
    setName(x.name)
    setBaseURL(x.baseURL)
    setErrors({})
  }

  const save = async () => {
    const errs: Record<string, string> = {}
    let parsedHeaders: Record<string, string> | null = null
    if (headers.trim()) {
      try {
        parsedHeaders = JSON.parse(headers)
      } catch {
        errs.headers = t('必须是 JSON 对象')
      }
    }
    if (type === 'openai-compatible' && !baseURL.trim()) errs.baseURL = t('兼容接口需要填写 Base URL')
    if (!editing && !apiKey && type !== 'openai-compatible') errs.apiKey = t('请填写 API Key')
    setErrors(errs)
    if (Object.keys(errs).length) return
    setSaving(true)
    try {
      const input: ProviderInput = {
        id: editing?.id,
        type,
        name: name.trim() || meta.label,
        baseURL: baseURL.trim() || null,
        headers: parsedHeaders,
        apiKey: apiKey ? apiKey : editing ? undefined : '',
      }
      const saved = await call('providers.save', input)
      toast.success(editing ? t('已保存提供方') : t('已添加提供方'))
      onClose()
      onSaved(saved, !editing)
    } catch (e) {
      toast.error(t('保存失败'), { description: errorMessage(e) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={editing ? t('编辑提供方') : t('添加提供方')}
        description={t('API Key 使用系统钥匙串加密保存在本机。')}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('取消')}
            </Button>
            <Button variant="primary" loading={saving} onClick={save}>
              {t('保存')}
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          {!editing ? (
            <div>
              <div className="mb-1.5 text-sm font-medium">{t('快速选择')}</div>
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((x) => (
                  <button
                    key={x.id}
                    onClick={() => applyPreset(x)}
                    className={cn(
                      'interactive h-7 rounded-md border px-2.5 text-xs',
                      preset?.id === x.id
                        ? 'border-primary/50 bg-info-soft text-brand'
                        : 'border-border text-muted-foreground hover:border-input hover:text-foreground',
                    )}
                  >
                    {x.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <Field label={t('接口类型')} hint={meta.hint}>
            <Select value={type} onChange={(v) => setType(v as ProviderType)} options={TYPES.map((t) => ({ value: t.value, label: t.label }))} />
          </Field>
          <Field label={t('名称')}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={meta.label} />
          </Field>
          <Field
            label="Base URL"
            hint={type === 'openai-compatible' ? t('兼容接口必填，例如 https://api.deepseek.com/v1') : t('留空使用默认值 {{v0}}', { v0: meta.baseURL })}
            error={errors.baseURL}
          >
            <Input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder={meta.baseURL} className="font-mono text-xs" />
          </Field>
          <Field
            label="API Key"
            hint={
              editing?.hasKey ? (
                t('已保存，留空表示不修改')
              ) : preset?.keyUrl ? (
                <Button variant="link" size="sm" className="text-xs" onClick={() => void call('app.openExternal', preset.keyUrl!)}>
                  {t('获取 {{v0}} API Key', { v0: preset.name })}
                  <ExternalLink className="size-3" />
                </Button>
              ) : preset?.id === 'ollama' ? (
                t('本地 Ollama 无需密钥')
              ) : undefined
            }
            error={errors.apiKey}
          >
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={editing?.hasKey ? '••••••••' : 'sk-…'}
              className="font-mono text-xs"
            />
          </Field>
          <Field label={t('自定义请求头（可选）')} hint={t('JSON，例如 {"X-Org": "team"}')} error={errors.headers}>
            <Textarea value={headers} onChange={(e) => setHeaders(e.target.value)} rows={3} className="font-mono text-xs" />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ModelDialog({ provider, model, onClose, onSaved }: { provider: Provider; model: ModelConfig | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState<ModelInput>(
    model ?? {
      providerId: provider.id,
      model: '',
      enabled: true,
      displayName: '',
      supportsTools: true,
      supportsVision: provider.type !== 'openai-compatible',
      temperature: null,
      maxTokens: null,
      reasoningEffort: null,
      contextWindow: null,
    },
  )
  const [remote, setRemote] = useState<string[] | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const fetchSequence = useRef(0)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const suggestions = presetFor(provider)?.models ?? []
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [affected, setAffected] = useState<{ id: string; name: string }[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [visionTouched, setVisionTouched] = useState(!!model)
  const set = <K extends keyof ModelInput>(k: K, v: ModelInput[K]) =>
    setForm((f) => ({ ...f, [k]: v, ...(k === 'model' && !visionTouched ? { supportsVision: guessVision(provider.type, v as string) } : {}) }))

  const fetchRemote = async () => {
    const sequence = ++fetchSequence.current
    setFetching(true)
    setFetchError(null)
    try {
      const list = await call('providers.fetchModels', provider.id)
      if (sequence !== fetchSequence.current) return
      setRemote(list)
      setPickerOpen(true)
    } catch (e) {
      if (sequence !== fetchSequence.current) return
      setFetchError(errorMessage(e).split('\n')[0])
    } finally {
      if (sequence === fetchSequence.current) setFetching(false)
    }
  }
  useEffect(
    () => () => {
      fetchSequence.current++
    },
    [],
  )

  const save = async () => {
    if (!form.model.trim()) return setError(t('请填写模型 ID'))
    setSaving(true)
    try {
      if (model?.enabled && form.enabled === false && affected === null) {
        const tasks = await call('models.affectedTasks', [model.id])
        if (tasks.length) {
          setAffected(tasks)
          return
        }
      }
      await call('models.save', {
        ...form,
        isDefault: form.enabled === false ? false : form.isDefault,
        model: form.model.trim(),
        displayName: form.displayName.trim() || form.model.trim(),
      })
      toast.success(t('已保存模型'))
      onSaved()
      onClose()
    } catch (e) {
      toast.error(t('保存失败'), { description: errorMessage(e) })
    } finally {
      setSaving(false)
    }
  }

  const num = (v: string) => (v.trim() === '' ? null : Number(v))

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={model ? t('编辑模型') : t('添加模型 · {{v0}}', { v0: provider.name })}
        onEscapeKeyDown={(event) => {
          if (pickerOpen) event.preventDefault()
        }}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('取消')}
            </Button>
            <Button variant="primary" loading={saving} onClick={save}>
              {t('保存')}
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          {affected?.length && form.enabled === false ? (
            <div role="alert" className="rounded border border-border p-3 text-sm">
              <p>{t('停用模型会影响以下任务')}</p>
              <p className="mt-1 text-muted-foreground">{t('任务仍保留原模型，请在任务设置中选择已启用模型。')}</p>
              {affected.map((task) => (
                <Link key={task.id} className="mt-2 block text-brand" to="/tasks" onClick={onClose}>
                  {task.name} · {t('查看任务')}
                </Link>
              ))}
            </div>
          ) : null}
          <Field
            label={t('模型 ID')}
            error={error ?? undefined}
            hint={
              <Button variant="link" size="sm" className="text-xs" loading={fetching} onClick={() => void fetchRemote()}>
                <Download className="size-3" />
                {t('从接口拉取可用模型')}
              </Button>
            }
          >
            <ModelIdInput
              value={form.model}
              onChange={(value) => {
                set('model', value)
                setError(null)
              }}
              options={remote ?? []}
              open={pickerOpen}
              onOpenChange={setPickerOpen}
              loading={fetching}
              loaded={remote !== null}
              placeholder={provider.type === 'anthropic' ? 'claude-sonnet-5' : 'gpt-5.1'}
            />
          </Field>
          {remote ? (
            <p className="-mt-2 text-xs text-muted-foreground">{t('已获取 {{v0}} 个模型，点击箭头选择，或输入名称筛选。', { v0: remote.length })}</p>
          ) : null}
          {fetchError ? (
            <p role="alert" className="-mt-2 text-xs text-danger">
              {fetchError}
            </p>
          ) : null}
          {fetchError && suggestions.length ? (
            <div className="-mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              {t('未能自动获取，常用模型：')}
              {suggestions.map((m) => (
                <button
                  key={m}
                  className="interactive rounded-sm border border-border px-1.5 py-0.5 font-mono hover:border-input hover:text-foreground"
                  onClick={() => set('model', m)}
                >
                  {m}
                </button>
              ))}
            </div>
          ) : null}
          <Field label={t('显示名称')}>
            <Input value={form.displayName} onChange={(e) => set('displayName', e.target.value)} placeholder={form.model || t('例如 Claude Sonnet')} />
          </Field>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span>{t('启用此模型')}</span>
            <Switch aria-label={t('启用此模型')} checked={form.enabled !== false} onCheckedChange={(enabled) => set('enabled', enabled)} />
          </label>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Temperature" hint={t('留空使用默认')}>
              <Input type="number" step="0.1" min={0} max={2} value={form.temperature ?? ''} onChange={(e) => set('temperature', num(e.target.value))} />
            </Field>
            <Field label={t('最大输出 Token')} hint={t('留空使用默认')}>
              <Input type="number" min={1} value={form.maxTokens ?? ''} onChange={(e) => set('maxTokens', num(e.target.value))} />
            </Field>
          </div>
          {provider.type === 'openai-responses' || provider.type === 'openai' ? (
            <Field label={t('推理强度')} hint={t('仅推理模型生效')}>
              <Select
                value={form.reasoningEffort ?? 'none'}
                onChange={(v) => set('reasoningEffort', v === 'none' ? null : (v as 'low' | 'medium' | 'high'))}
                options={[
                  { value: 'none', label: t('默认') },
                  { value: 'low', label: t('低') },
                  { value: 'medium', label: t('中') },
                  { value: 'high', label: t('高') },
                ]}
              />
            </Field>
          ) : null}
          <div className="grid gap-3 rounded-md border border-border p-3">
            <label className="flex items-center justify-between gap-4 text-sm">
              <span>
                {t('支持工具调用')}
                <span className="block text-xs text-muted-foreground">{t('Agent 需要工具调用能力才能操作浏览器')}</span>
              </span>
              <Switch checked={form.supportsTools} onCheckedChange={(v) => set('supportsTools', v)} />
            </label>
            <label className="flex items-center justify-between gap-4 text-sm">
              <span>
                {t('支持图像输入')}
                <span className="block text-xs text-muted-foreground">{t('开启后截图、图片附件和扫描件页面会直接发给模型看图；关闭则只发送 OCR 文字')}</span>
              </span>
              <Switch
                checked={form.supportsVision}
                onCheckedChange={(v) => {
                  setVisionTouched(true)
                  set('supportsVision', v)
                }}
              />
            </label>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ModelRow({
  m,
  onEdit,
  reload,
  selected,
  onSelect,
  onToggle,
}: {
  m: ModelConfig
  onEdit: () => void
  reload: () => void
  selected: boolean
  onSelect: () => void
  onToggle: (ids: string[], enabled: boolean) => Promise<void>
}) {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; latencyMs: number; error?: string } | null>(null)
  const [pricing, setPricing] = useState(false)
  const [updating, setUpdating] = useState(false)
  const toggle = async (enabled: boolean) => {
    setUpdating(true)
    try {
      await onToggle([m.id], enabled)
      reload()
    } catch (e) {
      toast.error(t('保存失败'), { description: errorMessage(e) })
    } finally {
      setUpdating(false)
    }
  }

  const test = async () => {
    setTesting(true)
    setResult(null)
    try {
      const r = await call('models.test', m.id)
      setResult(r)
      if (r.ok) toast.success(t('{{v0}} 连接正常', { v0: m.displayName }), { description: `${r.latencyMs} ms` })
      else toast.error(t('{{v0}} 连接失败', { v0: m.displayName }), { description: r.error })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="group flex min-h-11 flex-wrap items-center gap-3 px-4 py-2" data-testid="model-row" data-model-id={m.model}>
      <input type="checkbox" checked={selected} onChange={onSelect} aria-label={t('选择模型 {{v0}}', { v0: m.displayName })} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{m.displayName}</span>
          {m.isDefault ? (
            <Badge variant="primary">
              <Star className="fill-current" />
              {t('默认')}
            </Badge>
          ) : null}
          {m.supportsVision ? <Badge variant="outline">{t('视觉')}</Badge> : null}
          {!m.supportsTools ? <Badge variant="warning">{t('无工具调用')}</Badge> : null}
          {m.reasoningEffort ? <Badge variant="outline">{t('推理 · {{v0}}', { v0: m.reasoningEffort })}</Badge> : null}
          {m.pricing ? (
            <Badge variant="outline" title={t('每百万 token：输入 / 输出')}>
              {CURRENCY_SYMBOL[m.pricing.currency]}
              {m.pricing.input} / {CURRENCY_SYMBOL[m.pricing.currency]}
              {m.pricing.output}
            </Badge>
          ) : null}
        </div>
        <div className="truncate font-mono text-xs text-muted-foreground">{m.model}</div>
      </div>
      {result ? (
        result.ok ? (
          <span className="flex items-center gap-1 text-xs text-success">
            <CheckCircle2 className="size-3.5" />
            {result.latencyMs} ms
          </span>
        ) : (
          <span className="max-w-48 truncate text-xs text-danger" title={result.error}>
            {result.error}
          </span>
        )
      ) : null}
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{m.enabled ? t('已启用') : t('已停用')}</span>
        <Switch
          checked={m.enabled}
          disabled={updating}
          onCheckedChange={(enabled) => void toggle(enabled)}
          aria-label={t('启用模型 {{v0}}', { v0: m.displayName })}
        />
      </label>
      <Button variant="ghost" size="sm" loading={testing} onClick={test}>
        {!testing ? <Zap /> : null}
        {t('测试')}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t('更多')}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {m.enabled && !m.isDefault ? (
            <DropdownMenuItem onSelect={async () => (await call('models.setDefault', m.id), reload())}>
              <Star />
              {t('设为默认')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil />
            {t('编辑')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setPricing(true)}>
            <Coins />
            {t('设置价格')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem danger onSelect={async () => (await call('models.delete', m.id), reload())}>
            <Trash2 />
            {t('删除')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {pricing ? <PricingDialog model={m} onClose={() => setPricing(false)} onSaved={reload} /> : null}
    </div>
  )
}

export function ModelsPage() {
  const { providers, models, error, load } = useModels()
  const [query, setQuery] = useState(() => localStorage.getItem('models.search') ?? '')
  const [filter, setFilter] = useState(() => localStorage.getItem('models.filter') ?? 'all')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [impact, setImpact] = useState<{ ids: string[]; tasks: { id: string; name: string }[] } | null>(null)
  useEffect(() => {
    localStorage.setItem('models.search', query)
    localStorage.setItem('models.filter', filter)
    setSelected(new Set())
  }, [query, filter])
  const applyEnabled = async (ids: string[], enabled: boolean) => {
    setBusy(true)
    try {
      await call('models.setEnabledMany', ids, enabled)
      setSelected(new Set())
      setImpact(null)
      await load()
    } catch (error) {
      toast.error(t('保存失败'), { description: errorMessage(error) })
    } finally {
      setBusy(false)
    }
  }
  const toggleEnabled = async (ids: string[], enabled: boolean) => {
    if (!enabled) {
      const tasks = await call('models.affectedTasks', ids)
      if (tasks.length) {
        setImpact({ ids, tasks })
        return
      }
    }
    await applyEnabled(ids, enabled)
  }
  const [providerDialog, setProviderDialog] = useState<Provider | 'new' | null>(null)
  const [modelDialog, setModelDialog] = useState<{ provider: Provider; model: ModelConfig | null } | null>(null)
  const [importing, setImporting] = useState<Set<string>>(new Set())
  const [importErrors, setImportErrors] = useState<Record<string, string>>({})
  const importModels = async (provider: Provider) => {
    setImporting((current) => new Set(current).add(provider.id))
    setImportErrors((current) => {
      const next = { ...current }
      delete next[provider.id]
      return next
    })
    try {
      const result = await call('providers.importModels', provider.id)
      await load()
      toast.success(t('新增 {{v0}} 个模型，默认停用；已有 {{v1}} 个模型保留原配置。', { v0: result.imported, v1: result.existing }))
    } catch (e) {
      setImportErrors((current) => ({ ...current, [provider.id]: errorMessage(e).split('\n')[0] }))
    } finally {
      setImporting((current) => {
        const next = new Set(current)
        next.delete(provider.id)
        return next
      })
    }
  }

  useEffect(() => {
    void load()
  }, [load])

  const removeProvider = async (p: Provider) => {
    try {
      await call('providers.delete', p.id)
      toast.success(t('已删除 {{v0}}', { v0: p.name }))
      void load()
    } catch (e) {
      toast.error(t('删除失败'), { description: errorMessage(e) })
    }
  }

  return (
    <Page>
      <PageHeader
        title={t('模型')}
        description={t('厂商模型自动导入并默认停用；启用后才会出现在对话选择器中，也可手动添加或编辑配置。')}
        actions={
          providers?.length ? (
            <Button variant="primary" onClick={() => setProviderDialog('new')}>
              <Plus />
              {t('添加提供方')}
            </Button>
          ) : null
        }
      />
      {error && !providers ? (
        <ErrorState error={error} onRetry={load} />
      ) : !providers || !models ? (
        <ListSkeleton rows={3} />
      ) : !providers.length ? (
        <Card>
          <EmptyState
            icon={Cpu}
            title={t('添加第一个模型提供方')}
            description={t('支持 Anthropic、OpenAI Chat Completions、OpenAI Responses 以及任何兼容 OpenAI 的接口。')}
            action={
              <Button variant="primary" onClick={() => setProviderDialog('new')}>
                <Plus />
                {t('添加提供方')}
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="min-w-48 flex-1"
              aria-label={t('搜索模型或厂商')}
              placeholder={t('搜索模型或厂商')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Select
              className="w-36"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: t('全部模型') },
                { value: 'enabled', label: t('已启用') },
                { value: 'disabled', label: t('已停用') },
              ]}
            />
            <Button disabled={!selected.size || busy} onClick={() => void toggleEnabled([...selected], true)}>
              {t('启用所选')}
            </Button>
            <Button disabled={!selected.size || busy} onClick={() => void toggleEnabled([...selected], false)}>
              {t('停用所选')}
            </Button>
          </div>
          {providers.map((p) => {
            const all = models.filter((m) => m.providerId === p.id)
            const list = all
              .filter(
                (m) =>
                  (filter === 'all' || m.enabled === (filter === 'enabled')) &&
                  `${p.name} ${m.displayName} ${m.model}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
              )
              .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.displayName.localeCompare(b.displayName))
            if (!list.length && (query || filter !== 'all')) return null
            return (
              <Card key={p.id} className="animate-fade-in" data-testid="provider-card" data-provider-id={p.id}>
                <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <button
                        className="flex items-center gap-1 text-base font-semibold"
                        aria-expanded={!collapsed.has(p.id)}
                        onClick={() =>
                          setCollapsed((current) => {
                            const next = new Set(current)
                            if (next.has(p.id)) next.delete(p.id)
                            else next.add(p.id)
                            return next
                          })
                        }
                      >
                        {collapsed.has(p.id) ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
                        {p.name}
                      </button>
                      <Badge>{typeLabel(p.type)}</Badge>
                      {p.hasKey ? (
                        <Badge variant="success">
                          <KeyRound />
                          {t('已配置密钥')}
                        </Badge>
                      ) : p.type !== 'openai-compatible' ? (
                        <Badge variant="warning">{t('缺少密钥')}</Badge>
                      ) : null}
                    </div>
                    <div className="truncate font-mono text-xs text-muted-foreground">{p.baseURL || TYPES.find((t) => t.value === p.type)?.baseURL}</div>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {t('已启用 {{v0}} / {{v1}}', { v0: all.filter((model) => model.enabled).length, v1: all.length })}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    loading={importing.has(p.id)}
                    aria-label={t('拉取 {{v0}} 的模型', { v0: p.name })}
                    onClick={() => void importModels(p)}
                  >
                    <Download />
                    {t('拉取模型')}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setModelDialog({ provider: p, model: null })}>
                    <Plus />
                    {t('添加模型')}
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={t('更多')}>
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setProviderDialog(p)}>
                        <Pencil />
                        {t('编辑提供方')}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem danger onSelect={() => void removeProvider(p)}>
                        <Trash2 />
                        {t('删除提供方')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {importErrors[p.id] ? (
                  <div role="alert" className="border-b border-border px-4 py-3 text-xs text-danger">
                    {importErrors[p.id]} {t('可重试拉取，或手动添加模型。')}
                  </div>
                ) : null}
                {collapsed.has(p.id) ? null : list.length ? (
                  <div className="divide-y divide-border">
                    {list.map((m) => (
                      <ModelRow
                        key={m.id}
                        m={m}
                        reload={load}
                        selected={selected.has(m.id)}
                        onSelect={() =>
                          setSelected((current) => {
                            const next = new Set(current)
                            if (next.has(m.id)) next.delete(m.id)
                            else next.add(m.id)
                            return next
                          })
                        }
                        onToggle={toggleEnabled}
                        onEdit={() => setModelDialog({ provider: p, model: m })}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="px-4 py-5 text-sm text-muted-foreground">
                    {t('该提供方还没有模型。')}
                    <Button variant="link" size="sm" onClick={() => setModelDialog({ provider: p, model: null })}>
                      {t('添加模型')}
                    </Button>
                  </p>
                )}
              </Card>
            )
          })}
        </div>
      )}
      {impact ? (
        <Dialog open onOpenChange={(open) => !open && setImpact(null)}>
          <DialogContent
            title={t('停用模型会影响以下任务')}
            footer={
              <>
                <Button onClick={() => setImpact(null)}>{t('取消')}</Button>
                <Button loading={busy} onClick={() => void applyEnabled(impact.ids, false)}>
                  {t('停用所选')}
                </Button>
              </>
            }
          >
            <p className="mb-3 text-sm text-muted-foreground">{t('任务仍保留原模型，请在任务设置中选择已启用模型。')}</p>
            <div className="grid gap-2">
              {impact.tasks.map((task) => (
                <Link key={task.id} to="/tasks" className="text-brand" onClick={() => setImpact(null)}>
                  {task.name} · {t('查看任务')}
                </Link>
              ))}
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
      {providerDialog ? (
        <ProviderDialog
          provider={providerDialog}
          onClose={() => setProviderDialog(null)}
          onSaved={(p, isNew) => {
            void load()
            if (isNew) void importModels(p)
          }}
        />
      ) : null}
      {modelDialog ? <ModelDialog {...modelDialog} onClose={() => setModelDialog(null)} onSaved={load} /> : null}
    </Page>
  )
}
