import {
  ArrowLeft,
  Check,
  Clapperboard,
  ExternalLink,
  Globe,
  Monitor,
  Moon,
  Newspaper,
  Plug,
  Radar,
  Search,
  Sparkles,
  Sun,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import type { DiscoveredMcp, Provider, Settings } from '@shared/types'
import { Logo, PRODUCT_NAME } from '@/components/brand/logo'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { EmptyState, ErrorState, ListSkeleton, Skeleton } from '@/components/ui/states'
import { useAsync } from '@/hooks/use-async'
import { call } from '@/lib/ipc'
import { PRESETS, type Preset, guessVision } from '@/lib/providers'
import { cn, errorMessage } from '@/lib/utils'
import { useChat } from '@/stores/chat'
import { useModels } from '@/stores/models'
import { useSettings } from '@/stores/settings'

const STEPS = ['连接模型', '导入能力', '外观', '完成'] as const

const CUSTOM: Preset = { id: 'custom', name: '其他兼容接口', type: 'openai-compatible', baseURL: '', models: [] }
const PRESET_HINTS: Record<string, string> = {
  anthropic: 'Claude 系列',
  openai: 'GPT 系列 · Responses API',
  deepseek: '国内直连 · 性价比高',
  qwen: '阿里云百炼',
  kimi: '月之暗面',
  glm: '智谱开放平台',
  siliconflow: '多家开源模型',
  openrouter: '一个 Key 用多家模型',
  ollama: '本地运行 · 无需密钥',
  custom: '填写任意 OpenAI 兼容地址',
}

const STARTERS: { icon: LucideIcon; text: string }[] = [
  { icon: Newspaper, text: '打开 Hacker News，总结今天排名前 5 的文章' },
  { icon: Search, text: '搜索 “LangGraph deepagents”，整理 3 个最有用的链接' },
  { icon: Sparkles, text: '记住：我偏好简洁的中文回答' },
]

function Stepper({ current }: { current: number }) {
  return (
    <ol className="mb-10 flex items-center gap-2" aria-label="设置进度">
      {STEPS.map((label, i) => {
        const done = i < current
        const active = i === current
        return (
          <li key={label} className="flex flex-1 items-center gap-2">
            <span
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium transition-colors duration-200',
                done && 'border-primary bg-primary text-primary-foreground',
                active && 'border-primary text-brand',
                !done && !active && 'border-border text-subtle-foreground',
              )}
              aria-current={active ? 'step' : undefined}
            >
              {done ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span className={cn('text-xs whitespace-nowrap', active ? 'font-medium text-foreground' : 'text-muted-foreground')}>{label}</span>
            {i < STEPS.length - 1 ? <span className={cn('h-px flex-1 transition-colors duration-200', done ? 'bg-primary' : 'bg-border')} /> : null}
          </li>
        )
      })}
    </ol>
  )
}

function Welcome() {
  const features: { icon: LucideIcon; title: string; text: string }[] = [
    { icon: Globe, title: '替你操作浏览器', text: '打开网页、搜索、填表、翻页采集，每一步都在右侧看得见、随时可接管。' },
    { icon: Plug, title: '连接你的工具', text: '接入 MCP 与连接器，复用 .agents 中已有的 Skill。' },
    { icon: Clapperboard, title: '把重复操作变成一键', text: '录制宏、编写站点插件，让 Agent 更快更稳地完成固定流程。' },
  ]
  return (
    <div>
      <Logo className="size-12" />
      <h1 className="mt-6 text-2xl font-semibold tracking-[-0.01em]">欢迎使用 {PRODUCT_NAME}</h1>
      <p className="mt-1.5 text-base text-muted-foreground">会自己上网干活的桌面 AI 助手。花一分钟完成设置，就可以开始了。</p>
      <div className="mt-8 grid gap-3">
        {features.map((f) => (
          <div key={f.title} className="flex items-start gap-3.5 rounded-lg border border-border bg-card px-4 py-3.5">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-info-soft">
              <f.icon className="size-4 stroke-[1.75] text-brand" />
            </div>
            <div>
              <div className="text-sm font-medium">{f.title}</div>
              <div className="mt-0.5 text-sm text-muted-foreground">{f.text}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

type ModelPhase = 'pick' | 'form' | 'connecting' | 'ready' | 'error'

interface ModelState {
  phase: ModelPhase
  preset: Preset | null
  provider: Provider | null
  models: string[]
  model: string
  modelId: string | null
  test: { ok: boolean; latencyMs: number; error?: string } | null
  error: string | null
}

/** Step 1: provider preset → key → fetch models → pick one → live test. */
function ModelStep({
  state,
  setState,
  onConnect,
  onTest,
}: {
  state: ModelState
  setState: (p: Partial<ModelState>) => void
  onConnect: (key: string, baseURL: string) => void
  onTest: (model: string) => void
}) {
  const [key, setKey] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const p = state.preset

  if (state.phase === 'pick' || !p) {
    return (
      <div>
        <h2 className="text-xl font-semibold">选择模型服务</h2>
        <p className="mt-1 text-sm text-muted-foreground">Agent 需要一个支持工具调用的大模型。选择你已有账号的服务商，之后可以在「模型」页面添加更多。</p>
        <div className="mt-6 grid grid-cols-2 gap-2 @lg:grid-cols-3">
          {[...PRESETS, CUSTOM].map((x) => (
            <button
              key={x.id}
              onClick={() => {
                setBaseURL(x.baseURL)
                setKey('')
                setState({ preset: x, phase: 'form', error: null })
              }}
              className="card-hover rounded-lg border border-border bg-card px-3.5 py-3 text-left"
            >
              <div className="text-sm font-medium">{x.name}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{PRESET_HINTS[x.id]}</div>
            </button>
          ))}
        </div>
      </div>
    )
  }

  const needsKey = p.id !== 'ollama'
  const needsUrl = p.id === 'custom'
  return (
    <div>
      <button
        onClick={() => setState({ phase: 'pick', provider: null, test: null, error: null })}
        className="interactive mb-4 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        重新选择服务商
      </button>
      <h2 className="text-xl font-semibold">连接 {p.name}</h2>
      <p className="mt-1 text-sm text-muted-foreground">密钥使用系统钥匙串加密保存在本机，不会上传到任何地方。</p>

      <div className="mt-6 grid gap-4">
        {needsUrl || p.type === 'openai-compatible' ? (
          <Field label="Base URL" hint={needsUrl ? '例如 https://api.example.com/v1' : undefined}>
            <Input
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
              className="font-mono text-xs"
              disabled={state.phase === 'connecting'}
              placeholder="https://…/v1"
            />
          </Field>
        ) : null}
        {needsKey ? (
          <Field
            label="API Key"
            hint={
              p.keyUrl ? (
                <Button variant="link" size="sm" className="text-xs" onClick={() => void call('app.openExternal', p.keyUrl!)}>
                  还没有？获取 {p.name} API Key
                  <ExternalLink className="size-3" />
                </Button>
              ) : undefined
            }
          >
            <Input
              type="password"
              value={key}
              autoFocus
              onChange={(e) => setKey(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && key && onConnect(key, baseURL)}
              placeholder={state.provider ? '已保存（重新填写可更换）' : 'sk-…'}
              className="font-mono text-xs"
              disabled={state.phase === 'connecting'}
            />
          </Field>
        ) : null}

        {state.phase === 'form' || state.phase === 'error' ? (
          <div className="flex items-center gap-3">
            <Button variant="secondary" disabled={(needsKey && !key && !state.provider) || (needsUrl && !baseURL)} onClick={() => onConnect(key, baseURL)}>
              连接
            </Button>
            {state.phase === 'error' && state.error ? <span className="text-xs text-danger">{state.error.split('\n')[0]}</span> : null}
          </div>
        ) : null}

        {state.phase === 'connecting' ? (
          <div className="grid gap-2 rounded-lg border border-border bg-card p-4" aria-busy="true">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-8 w-full" />
            <p className="text-xs text-muted-foreground">正在连接并获取可用模型…</p>
          </div>
        ) : null}

        {state.phase === 'ready' ? (
          <div className="grid animate-fade-in gap-3 rounded-lg border border-border bg-card p-4">
            <Field label="默认模型" hint={state.models.length ? `共 ${state.models.length} 个可用模型` : '未能自动获取模型列表，可手动填写模型 ID'}>
              {state.models.length ? (
                <Select value={state.model} onChange={(v) => onTest(v)} options={state.models.map((m) => ({ value: m, label: m }))} />
              ) : (
                <Input
                  value={state.model}
                  onChange={(e) => setState({ model: e.target.value, test: null })}
                  onBlur={() => state.model && onTest(state.model)}
                  className="font-mono text-xs"
                  placeholder="模型 ID"
                />
              )}
            </Field>
            {state.test == null ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="size-1.5 animate-pulse rounded-full bg-brand" />
                正在测试模型…
              </p>
            ) : state.test.ok ? (
              <p className="flex items-center gap-1.5 text-xs text-success">
                <Check className="size-3.5" />
                连接成功 · {state.test.latencyMs} ms
              </p>
            ) : (
              <ErrorState error={state.test.error ?? '测试失败'} onRetry={() => onTest(state.model)} compact />
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** Step 2: show what's picked up automatically (skills) and offer MCP servers found on this machine. */
function ImportStep({ picked, setPicked }: { picked: Set<string>; setPicked: (s: Set<string>) => void }) {
  const sources = useAsync(() => call('skills.sources'))
  const found = useAsync(() => call('mcp.discover'))
  const skillCount = (sources.data ?? []).filter((s) => s.id !== 'local').reduce((n, s) => n + s.skillCount, 0)
  const importable = (found.data ?? []).filter((d) => !d.imported)
  const toggle = (d: DiscoveredMcp) => {
    const n = new Set(picked)
    if (n.has(d.key)) n.delete(d.key)
    else n.add(d.key)
    setPicked(n)
  }
  return (
    <div>
      <h2 className="text-xl font-semibold">导入已有能力</h2>
      <p className="mt-1 text-sm text-muted-foreground">从本机其他 Agent 工具中复用 Skill 与 MCP 服务器。只会读取它们的配置，不会修改。</p>

      <div className="mt-6 rounded-lg border border-border bg-card px-4 py-3.5">
        {sources.data === undefined ? (
          <Skeleton className="h-4 w-2/3" />
        ) : (
          <div className="flex items-center gap-3">
            <Sparkles className="size-4 shrink-0 stroke-[1.75] text-brand" />
            <div className="min-w-0 flex-1 text-sm">
              {skillCount ? (
                <>
                  已自动接入 <span className="font-medium">{skillCount}</span> 个 Skill
                </>
              ) : (
                '没有发现共享的 Skill'
              )}
              <div className="truncate text-xs text-muted-foreground">
                {(sources.data ?? [])
                  .filter((s) => s.id !== 'local' && s.skillCount)
                  .map((s) => `${s.label} ${s.skillCount}`)
                  .join(' · ') || '会扫描 ~/.agents/skills、~/.claude/skills 等目录'}
              </div>
            </div>
            {skillCount ? <Badge variant="success">只读接入</Badge> : null}
          </div>
        )}
      </div>

      <div className="mt-6 mb-2 flex items-end justify-between">
        <div>
          <div className="text-sm font-medium">MCP 服务器</div>
          <div className="text-xs text-muted-foreground">来自 .agents、Claude Code、Cursor、Codex 等的配置</div>
        </div>
        {importable.length > 1 ? (
          <Button
            variant="link"
            size="sm"
            className="text-xs"
            onClick={() => setPicked(picked.size === importable.length ? new Set() : new Set(importable.map((d) => d.key)))}
          >
            {picked.size === importable.length ? '取消全选' : '全选'}
          </Button>
        ) : null}
      </div>
      {found.error && !found.data ? (
        <ErrorState error={found.error} onRetry={found.reload} compact />
      ) : !found.data ? (
        <ListSkeleton rows={2} />
      ) : !found.data.length ? (
        <EmptyState
          icon={Radar}
          title="没有发现 MCP 配置"
          description="之后可以在「MCP」页面手动添加。"
          className="rounded-lg border border-dashed border-border py-8"
        />
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
          {found.data.map((d) => (
            <label
              key={d.key}
              className={cn(
                'interactive flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2.5',
                d.imported ? 'opacity-60' : 'cursor-pointer hover:bg-accent/50',
                picked.has(d.key) && 'border-primary/40 bg-info-soft',
              )}
            >
              <input
                type="checkbox"
                className="accent-[var(--primary)]"
                disabled={d.imported}
                checked={d.imported || picked.has(d.key)}
                onChange={() => toggle(d)}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-sm">
                  <span className="font-medium">{d.name}</span>
                  <span className="text-xs text-subtle-foreground">{d.sourceLabel}</span>
                </div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {d.transport === 'stdio' ? `${d.command} ${(d.args ?? []).join(' ')}` : d.url}
                </div>
              </div>
              {d.imported ? <Badge variant="success">已导入</Badge> : <Badge variant="outline">{d.transport}</Badge>}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

function ThemePreview({ dark }: { dark: boolean }) {
  return (
    <div
      className={cn(
        'pointer-events-none flex h-20 overflow-hidden rounded-md border',
        dark ? 'border-[#1e2a3d] bg-[#0b1220]' : 'border-[#e4e7ec] bg-[#f6f7f9]',
      )}
    >
      <div className={cn('w-1/4 border-r p-1.5', dark ? 'border-[#1e2a3d] bg-[#0e1626]' : 'border-[#e4e7ec] bg-[#f2f4f7]')}>
        <div className="mb-1 h-1.5 w-3/4 rounded-sm bg-[#4474f2]" />
        <div className={cn('mb-1 h-1.5 rounded-sm', dark ? 'bg-[#1a2544]' : 'bg-[#e6ebf5]')} />
        <div className={cn('h-1.5 w-2/3 rounded-sm', dark ? 'bg-[#1a2544]' : 'bg-[#e6ebf5]')} />
      </div>
      <div className="flex-1 p-2">
        <div className={cn('mb-1.5 ml-auto h-2 w-1/2 rounded-sm', dark ? 'bg-[#172235]' : 'bg-[#eef1f5]')} />
        <div className={cn('mb-1 h-1.5 w-5/6 rounded-sm', dark ? 'bg-[#27354d]' : 'bg-[#d9dde3]')} />
        <div className={cn('h-1.5 w-2/3 rounded-sm', dark ? 'bg-[#27354d]' : 'bg-[#d9dde3]')} />
      </div>
    </div>
  )
}

function ThemeStep() {
  const { settings, update } = useSettings()
  const options: { value: Settings['theme']; label: string; icon: LucideIcon }[] = [
    { value: 'light', label: '浅色', icon: Sun },
    { value: 'dark', label: '深色', icon: Moon },
    { value: 'system', label: '跟随系统', icon: Monitor },
  ]
  return (
    <div>
      <h2 className="text-xl font-semibold">选择外观</h2>
      <p className="mt-1 text-sm text-muted-foreground">随时可以在「设置」中更改。</p>
      <div className="mt-6 grid grid-cols-3 gap-3">
        {options.map((o) => {
          const active = settings?.theme === o.value
          return (
            <button
              key={o.value}
              onClick={() => void update({ theme: o.value })}
              aria-pressed={active}
              className={cn('card-hover rounded-lg border bg-card p-2.5 text-left', active ? 'border-primary ring-2 ring-ring' : 'border-border')}
            >
              {o.value === 'system' ? (
                <div className="grid grid-cols-2 gap-1">
                  <ThemePreview dark={false} />
                  <ThemePreview dark />
                </div>
              ) : (
                <ThemePreview dark={o.value === 'dark'} />
              )}
              <div className="mt-2.5 flex items-center gap-1.5 px-0.5 text-sm">
                <o.icon className="size-3.5 stroke-[1.75] text-muted-foreground" />
                {o.label}
                {active ? <Check className="ml-auto size-3.5 text-brand" /> : null}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function DoneStep({ summary, onStart }: { summary: { model?: string; mcp: number }; onStart: (prompt?: string) => void }) {
  return (
    <div className="pt-2">
      <div className="flex size-10 items-center justify-center rounded-full bg-success-soft">
        <Check className="size-5 text-success" />
      </div>
      <h2 className="mt-5 text-xl font-semibold">一切就绪</h2>
      <ul className="mt-3 grid gap-1.5 text-sm text-muted-foreground">
        <li className="flex items-center gap-2">
          <Check className={cn('size-3.5', summary.model ? 'text-success' : 'text-subtle-foreground')} />
          {summary.model ? `默认模型：${summary.model}` : '模型：稍后在「模型」页面配置'}
        </li>
        <li className="flex items-center gap-2">
          <Check className={cn('size-3.5', summary.mcp ? 'text-success' : 'text-subtle-foreground')} />
          {summary.mcp ? `已导入 ${summary.mcp} 个 MCP 服务器` : '未导入 MCP 服务器'}
        </li>
      </ul>
      {summary.model ? (
        <>
          <div className="mt-8 mb-2 text-sm font-medium">试试这些</div>
          <div className="grid gap-2">
            {STARTERS.map((s) => (
              <button
                key={s.text}
                onClick={() => onStart(s.text)}
                className="card-hover flex items-center gap-3 rounded-lg border border-border bg-card px-3.5 py-3 text-left text-sm"
              >
                <s.icon className="size-4 shrink-0 stroke-[1.75] text-brand" />
                {s.text}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}

export function Onboarding() {
  const navigate = useNavigate()
  const update = useSettings((s) => s.update)
  const [step, setStep] = useState(-1) // -1 = welcome
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [imported, setImported] = useState(0)
  const [m, setM] = useState<ModelState>({ phase: 'pick', preset: null, provider: null, models: [], model: '', modelId: null, test: null, error: null })
  const patch = (p: Partial<ModelState>) => setM((s) => ({ ...s, ...p }))
  const isMac = window.api.platform === 'darwin'

  useEffect(() => {
    document.title = `欢迎使用 ${PRODUCT_NAME}`
  }, [])

  const testModel = async (modelName: string, provider = m.provider) => {
    if (!provider || !modelName) return
    patch({ model: modelName, test: null })
    try {
      const saved = await call('models.save', {
        id: m.modelId ?? undefined,
        providerId: provider.id,
        model: modelName,
        displayName: modelName,
        supportsTools: true,
        supportsVision: guessVision(provider.type, modelName),
        isDefault: true,
      })
      patch({ modelId: saved.id })
      const r = await call('models.test', saved.id)
      patch({ test: r })
    } catch (e) {
      patch({ test: { ok: false, latencyMs: 0, error: errorMessage(e) } })
    }
  }

  const connect = async (key: string, baseURL: string) => {
    const p = m.preset!
    patch({ phase: 'connecting', error: null, test: null })
    try {
      const provider = await call('providers.save', {
        id: m.provider?.id,
        type: p.type,
        name: p.id === 'custom' ? '自定义接口' : p.name,
        baseURL: baseURL.trim() || null,
        apiKey: key ? key.trim() : m.provider ? undefined : '',
      })
      let models: string[] = []
      try {
        models = await call('providers.fetchModels', provider.id)
      } catch {
        models = p.models
      }
      const preferred = p.models.find((x) => models.includes(x)) ?? models[0] ?? p.models[0] ?? ''
      patch({ provider, models, phase: 'ready' })
      if (preferred) await testModel(preferred, provider)
      else patch({ model: '' })
    } catch (e) {
      patch({ phase: 'error', error: errorMessage(e) })
    }
  }

  const finish = async (prompt?: string) => {
    await update({ onboarded: true })
    await useModels.getState().load()
    navigate('/chat')
    if (prompt && m.modelId) {
      const chat = useChat.getState()
      await chat.newThread(m.modelId)
      void chat.send(prompt)
    }
  }

  const next = async () => {
    if (step === 1 && picked.size) {
      setBusy(true)
      try {
        const list = await call('mcp.importDiscovered', [...picked])
        setImported(list.length)
      } finally {
        setBusy(false)
      }
    }
    setStep((s) => s + 1)
  }

  const primary = useMemo(() => {
    if (step === -1) return { label: '开始设置', disabled: false }
    if (step === 0) return { label: '下一步', disabled: !m.test?.ok }
    if (step === 1) return { label: picked.size ? `导入 ${picked.size} 项并继续` : '下一步', disabled: false }
    if (step === 2) return { label: '下一步', disabled: false }
    return { label: '开始使用', disabled: false }
  }, [step, m.test, picked.size])

  return (
    <div className="flex h-full flex-col bg-background" role="dialog" aria-label="首次设置">
      <header className={cn('drag flex h-11 shrink-0 items-center justify-end px-4', isMac && 'pl-[84px]')}>
        {step < 3 ? (
          <Button variant="ghost" size="sm" className="no-drag text-xs" onClick={() => void finish()}>
            跳过引导
          </Button>
        ) : null}
      </header>
      <main className="@container min-h-0 flex-1 overflow-y-auto">
        <div className={cn('mx-auto w-full max-w-[600px] px-6 pt-6 pb-10', step === -1 && 'flex min-h-full flex-col justify-center pb-24')}>
          {step >= 0 ? <Stepper current={step} /> : null}
          <div key={step} className="animate-fade-in">
            {step === -1 ? <Welcome /> : null}
            {step === 0 ? <ModelStep state={m} setState={patch} onConnect={(k, u) => void connect(k, u)} onTest={(model) => void testModel(model)} /> : null}
            {step === 1 ? <ImportStep picked={picked} setPicked={setPicked} /> : null}
            {step === 2 ? <ThemeStep /> : null}
            {step === 3 ? <DoneStep summary={{ model: m.test?.ok ? m.model : undefined, mcp: imported }} onStart={(p) => void finish(p)} /> : null}
          </div>
        </div>
      </main>
      <footer className="shrink-0 border-t border-border bg-card">
        <div className="mx-auto flex w-full max-w-[600px] items-center gap-2 px-6 py-3.5">
          {step >= 0 && step < 3 ? (
            <Button variant="ghost" onClick={() => setStep((s) => s - 1)}>
              上一步
            </Button>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            {step === 0 && !m.test?.ok ? (
              <Button variant="ghost" onClick={() => setStep(1)}>
                稍后配置
              </Button>
            ) : null}
            <Button variant="primary" size="lg" loading={busy} disabled={primary.disabled} onClick={() => (step === 3 ? void finish() : void next())}>
              {primary.label}
            </Button>
          </div>
        </div>
      </footer>
    </div>
  )
}
