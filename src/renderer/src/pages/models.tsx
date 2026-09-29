import { CheckCircle2, Cpu, Download, ExternalLink, KeyRound, MoreHorizontal, Pencil, Plus, Star, Trash2, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { ModelConfig, ModelInput, Provider, ProviderInput, ProviderType } from '@shared/types'
import { Page, PageHeader } from '@/components/layout/page'
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

const TYPES: { value: ProviderType; label: string; hint: string; baseURL: string }[] = [
  { value: 'anthropic', label: 'Anthropic', hint: 'Claude 系列，Messages API', baseURL: 'https://api.anthropic.com' },
  { value: 'openai', label: 'OpenAI · Chat Completions', hint: '/v1/chat/completions', baseURL: 'https://api.openai.com/v1' },
  { value: 'openai-responses', label: 'OpenAI · Responses', hint: '/v1/responses，支持推理与内置工具', baseURL: 'https://api.openai.com/v1' },
  { value: 'openai-compatible', label: 'OpenAI 兼容接口', hint: 'DeepSeek、通义千问、Ollama、vLLM 等', baseURL: 'http://localhost:11434/v1' },
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
        errs.headers = '必须是 JSON 对象'
      }
    }
    if (type === 'openai-compatible' && !baseURL.trim()) errs.baseURL = '兼容接口需要填写 Base URL'
    if (!editing && !apiKey && type !== 'openai-compatible') errs.apiKey = '请填写 API Key'
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
      toast.success(editing ? '已保存提供方' : '已添加提供方')
      onClose()
      onSaved(saved, !editing)
    } catch (e) {
      toast.error('保存失败', { description: errorMessage(e) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={editing ? '编辑提供方' : '添加提供方'}
        description="API Key 使用系统钥匙串加密保存在本机。"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" loading={saving} onClick={save}>
              保存
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          {!editing ? (
            <div>
              <div className="mb-1.5 text-sm font-medium">快速选择</div>
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
          <Field label="接口类型" hint={meta.hint}>
            <Select value={type} onChange={(v) => setType(v as ProviderType)} options={TYPES.map((t) => ({ value: t.value, label: t.label }))} />
          </Field>
          <Field label="名称">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={meta.label} />
          </Field>
          <Field
            label="Base URL"
            hint={type === 'openai-compatible' ? '兼容接口必填，例如 https://api.deepseek.com/v1' : `留空使用默认值 ${meta.baseURL}`}
            error={errors.baseURL}
          >
            <Input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder={meta.baseURL} className="font-mono text-xs" />
          </Field>
          <Field
            label="API Key"
            hint={
              editing?.hasKey ? (
                '已保存，留空表示不修改'
              ) : preset?.keyUrl ? (
                <Button variant="link" size="sm" className="text-xs" onClick={() => void call('app.openExternal', preset.keyUrl!)}>
                  获取 {preset.name} API Key
                  <ExternalLink className="size-3" />
                </Button>
              ) : preset?.id === 'ollama' ? (
                '本地 Ollama 无需密钥'
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
          <Field label="自定义请求头（可选）" hint='JSON，例如 {"X-Org": "team"}' error={errors.headers}>
            <Textarea value={headers} onChange={(e) => setHeaders(e.target.value)} rows={3} className="font-mono text-xs" />
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ModelDialog({
  provider,
  model,
  onClose,
  onSaved,
  autoFetch,
}: {
  provider: Provider
  model: ModelConfig | null
  onClose: () => void
  onSaved: () => void
  autoFetch?: boolean
}) {
  const [form, setForm] = useState<ModelInput>(
    model ?? {
      providerId: provider.id,
      model: '',
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
  const [fetchError, setFetchError] = useState<string | null>(null)
  const suggestions = presetFor(provider)?.models ?? []
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [visionTouched, setVisionTouched] = useState(!!model)
  const set = <K extends keyof ModelInput>(k: K, v: ModelInput[K]) =>
    setForm((f) => ({ ...f, [k]: v, ...(k === 'model' && !visionTouched ? { supportsVision: guessVision(provider.type, v as string) } : {}) }))

  const fetchRemote = async (quiet = false) => {
    setFetching(true)
    setFetchError(null)
    try {
      const list = await call('providers.fetchModels', provider.id)
      setRemote(list)
      if (!form.model && list.length) set('model', suggestions.find((x) => list.includes(x)) ?? list[0])
    } catch (e) {
      setFetchError(errorMessage(e).split('\n')[0])
      if (!quiet) toast.error('获取模型列表失败', { description: errorMessage(e).split('\n')[0] })
      if (!form.model && suggestions[0]) set('model', suggestions[0])
    } finally {
      setFetching(false)
    }
  }

  useEffect(() => {
    if (autoFetch) void fetchRemote(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = async () => {
    if (!form.model.trim()) return setError('请填写模型 ID')
    setSaving(true)
    try {
      await call('models.save', { ...form, model: form.model.trim(), displayName: form.displayName.trim() || form.model.trim() })
      toast.success('已保存模型')
      onSaved()
      onClose()
    } catch (e) {
      toast.error('保存失败', { description: errorMessage(e) })
    } finally {
      setSaving(false)
    }
  }

  const num = (v: string) => (v.trim() === '' ? null : Number(v))

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={model ? '编辑模型' : `添加模型 · ${provider.name}`}
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              取消
            </Button>
            <Button variant="primary" loading={saving} onClick={save}>
              保存
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <Field
            label="模型 ID"
            error={error ?? undefined}
            hint={
              <Button variant="link" size="sm" className="text-xs" loading={fetching} onClick={() => void fetchRemote()}>
                <Download className="size-3" />
                从接口拉取可用模型
              </Button>
            }
          >
            <Input
              list="remote-models"
              value={form.model}
              onChange={(e) => {
                set('model', e.target.value)
                setError(null)
              }}
              placeholder={provider.type === 'anthropic' ? 'claude-sonnet-5' : 'gpt-5.1'}
              className="font-mono text-xs"
            />
            <datalist id="remote-models">
              {remote?.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </Field>
          {remote ? <p className="-mt-2 text-xs text-muted-foreground">已获取 {remote.length} 个模型，输入时可下拉选择。</p> : null}
          {fetchError && suggestions.length ? (
            <div className="-mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              未能自动获取，常用模型：
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
          <Field label="显示名称">
            <Input value={form.displayName} onChange={(e) => set('displayName', e.target.value)} placeholder={form.model || '例如 Claude Sonnet'} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Temperature" hint="留空使用默认">
              <Input type="number" step="0.1" min={0} max={2} value={form.temperature ?? ''} onChange={(e) => set('temperature', num(e.target.value))} />
            </Field>
            <Field label="最大输出 Token" hint="留空使用默认">
              <Input type="number" min={1} value={form.maxTokens ?? ''} onChange={(e) => set('maxTokens', num(e.target.value))} />
            </Field>
          </div>
          {provider.type === 'openai-responses' || provider.type === 'openai' ? (
            <Field label="推理强度" hint="仅推理模型生效">
              <Select
                value={form.reasoningEffort ?? 'none'}
                onChange={(v) => set('reasoningEffort', v === 'none' ? null : (v as 'low' | 'medium' | 'high'))}
                options={[
                  { value: 'none', label: '默认' },
                  { value: 'low', label: '低' },
                  { value: 'medium', label: '中' },
                  { value: 'high', label: '高' },
                ]}
              />
            </Field>
          ) : null}
          <div className="grid gap-3 rounded-md border border-border p-3">
            <label className="flex items-center justify-between gap-4 text-sm">
              <span>
                支持工具调用
                <span className="block text-xs text-muted-foreground">Agent 需要工具调用能力才能操作浏览器</span>
              </span>
              <Switch checked={form.supportsTools} onCheckedChange={(v) => set('supportsTools', v)} />
            </label>
            <label className="flex items-center justify-between gap-4 text-sm">
              <span>
                支持图像输入
                <span className="block text-xs text-muted-foreground">开启后截图、图片附件和扫描件页面会直接发给模型看图；关闭则只发送 OCR 文字</span>
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

function ModelRow({ m, onEdit, reload }: { m: ModelConfig; onEdit: () => void; reload: () => void }) {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; latencyMs: number; error?: string } | null>(null)

  const test = async () => {
    setTesting(true)
    setResult(null)
    try {
      const r = await call('models.test', m.id)
      setResult(r)
      if (r.ok) toast.success(`${m.displayName} 连接正常`, { description: `${r.latencyMs} ms` })
      else toast.error(`${m.displayName} 连接失败`, { description: r.error })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="group flex min-h-11 items-center gap-3 px-4 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{m.displayName}</span>
          {m.isDefault ? (
            <Badge variant="primary">
              <Star className="fill-current" />
              默认
            </Badge>
          ) : null}
          {m.supportsVision ? <Badge variant="outline">视觉</Badge> : null}
          {!m.supportsTools ? <Badge variant="warning">无工具调用</Badge> : null}
          {m.reasoningEffort ? <Badge variant="outline">推理 · {m.reasoningEffort}</Badge> : null}
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
      <Button variant="ghost" size="sm" loading={testing} onClick={test}>
        {!testing ? <Zap /> : null}
        测试
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="更多">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {!m.isDefault ? (
            <DropdownMenuItem onSelect={async () => (await call('models.setDefault', m.id), reload())}>
              <Star />
              设为默认
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil />
            编辑
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem danger onSelect={async () => (await call('models.delete', m.id), reload())}>
            <Trash2 />
            删除
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function ModelsPage() {
  const { providers, models, error, load } = useModels()
  const [providerDialog, setProviderDialog] = useState<Provider | 'new' | null>(null)
  const [modelDialog, setModelDialog] = useState<{ provider: Provider; model: ModelConfig | null; autoFetch?: boolean } | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  const removeProvider = async (p: Provider) => {
    try {
      await call('providers.delete', p.id)
      toast.success(`已删除 ${p.name}`)
      void load()
    } catch (e) {
      toast.error('删除失败', { description: errorMessage(e) })
    }
  }

  return (
    <Page>
      <PageHeader
        title="模型"
        description="管理模型提供方与可用模型。对话中可随时切换，新对话使用默认模型。"
        actions={
          providers?.length ? (
            <Button variant="primary" onClick={() => setProviderDialog('new')}>
              <Plus />
              添加提供方
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
            title="添加第一个模型提供方"
            description="支持 Anthropic、OpenAI Chat Completions、OpenAI Responses 以及任何兼容 OpenAI 的接口。"
            action={
              <Button variant="primary" onClick={() => setProviderDialog('new')}>
                <Plus />
                添加提供方
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4">
          {providers.map((p) => {
            const list = models.filter((m) => m.providerId === p.id)
            return (
              <Card key={p.id} className="animate-fade-in">
                <div className="flex items-center gap-3 border-b border-border px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-base font-semibold">{p.name}</span>
                      <Badge>{typeLabel(p.type)}</Badge>
                      {p.hasKey ? (
                        <Badge variant="success">
                          <KeyRound />
                          已配置密钥
                        </Badge>
                      ) : p.type !== 'openai-compatible' ? (
                        <Badge variant="warning">缺少密钥</Badge>
                      ) : null}
                    </div>
                    <div className="truncate font-mono text-xs text-muted-foreground">{p.baseURL || TYPES.find((t) => t.value === p.type)?.baseURL}</div>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => setModelDialog({ provider: p, model: null })}>
                    <Plus />
                    添加模型
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label="更多">
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setProviderDialog(p)}>
                        <Pencil />
                        编辑提供方
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem danger onSelect={() => void removeProvider(p)}>
                        <Trash2 />
                        删除提供方
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {list.length ? (
                  <div className="divide-y divide-border">
                    {list.map((m) => (
                      <ModelRow key={m.id} m={m} reload={load} onEdit={() => setModelDialog({ provider: p, model: m })} />
                    ))}
                  </div>
                ) : (
                  <p className="px-4 py-5 text-sm text-muted-foreground">
                    该提供方还没有模型。
                    <Button variant="link" size="sm" onClick={() => setModelDialog({ provider: p, model: null })}>
                      添加模型
                    </Button>
                  </p>
                )}
              </Card>
            )
          })}
        </div>
      )}
      {providerDialog ? (
        <ProviderDialog
          provider={providerDialog}
          onClose={() => setProviderDialog(null)}
          onSaved={(p, isNew) => {
            void load()
            // a new provider is useless without a model: continue straight into picking one
            if (isNew) setModelDialog({ provider: p, model: null, autoFetch: true })
          }}
        />
      ) : null}
      {modelDialog ? <ModelDialog {...modelDialog} onClose={() => setModelDialog(null)} onSaved={load} /> : null}
    </Page>
  )
}
