import { Monitor, Moon, Sun } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import type { Settings } from '@shared/types'
import { Page, PageHeader } from '@/components/layout/page'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input, Textarea } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { ErrorState, Skeleton } from '@/components/ui/states'
import { Switch } from '@/components/ui/switch'
import { useAsync } from '@/hooks/use-async'
import { call } from '@/lib/ipc'
import { cn, errorMessage } from '@/lib/utils'
import { useSettings } from '@/stores/settings'

const APPROVAL_OPTIONS = [
  { name: 'browser_eval', label: '执行页面脚本' },
  { name: 'browser_upload_file', label: '上传文件' },
  { name: 'browser_click', label: '点击网页元素' },
  { name: 'browser_type', label: '在网页中输入' },
  { name: 'write_file', label: '写入文件' },
  { name: 'edit_file', label: '编辑文件' },
]

function Row({ title, description, children, className }: { title: string; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-start justify-between gap-8 px-5 py-4', className)}>
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        {description ? <div className="mt-0.5 text-xs text-muted-foreground">{description}</div> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

const LANGFUSE_HOSTS = [
  { value: 'https://cloud.langfuse.com', label: 'Langfuse Cloud · EU' },
  { value: 'https://us.cloud.langfuse.com', label: 'Langfuse Cloud · US' },
  { value: 'custom', label: '自建 / 其他地址' },
]

/** Langfuse tracing: every agent run becomes a trace (session = conversation). */
function LangfuseSection() {
  const { settings, update } = useSettings()
  const lf = settings!.langfuse
  const preset = LANGFUSE_HOSTS.some((h) => h.value === lf.baseUrl) ? lf.baseUrl : 'custom'
  const [host, setHost] = useState(preset)
  const [baseUrl, setBaseUrl] = useState(lf.baseUrl)
  const [publicKey, setPublicKey] = useState(lf.publicKey)
  const [secret, setSecret] = useState('')
  const [environment, setEnvironment] = useState(lf.environment)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const dirty = baseUrl !== lf.baseUrl || publicKey !== lf.publicKey || !!secret || environment !== lf.environment
  const complete = !!publicKey && (lf.secretKeySet || !!secret)

  const save = async () => {
    await update({
      langfuse: { ...lf, baseUrl: baseUrl.trim().replace(/\/+$/, ''), publicKey: publicKey.trim(), environment: environment.trim() || 'production' },
      langfuseSecretKey: secret || undefined,
    })
    setSecret('')
  }
  const test = async () => {
    setTesting(true)
    setResult(null)
    try {
      if (dirty) await save()
      const r = await call('langfuse.test')
      setResult(r.ok ? { ok: true, text: `连接成功 · 项目「${r.projectName ?? r.projectId}」` } : { ok: false, text: r.error ?? '连接失败' })
      await useSettings.getState().load()
    } finally {
      setTesting(false)
    }
  }

  return (
    <>
      <h2 className="mb-2 text-sm font-semibold">可观测性</h2>
      <Card className="mb-8 divide-y divide-border">
        <Row title="Langfuse 追踪" description="记录每次 Agent 运行的模型调用、工具调用、耗时与 Token 用量，按对话归为同一个 Session">
          <Switch
            checked={lf.enabled}
            disabled={!complete && !lf.enabled}
            onCheckedChange={(v) => void update({ langfuse: { ...lf, enabled: v } })}
            aria-label="启用 Langfuse"
          />
        </Row>
        <div className="grid gap-3 px-5 py-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <span className="text-xs text-muted-foreground">服务地址</span>
              <Select
                value={host}
                onChange={(v) => {
                  setHost(v)
                  if (v !== 'custom') setBaseUrl(v)
                }}
                options={LANGFUSE_HOSTS}
              />
            </div>
            <div className="grid gap-1.5">
              <span className="text-xs text-muted-foreground">环境</span>
              <Input value={environment} onChange={(e) => setEnvironment(e.target.value)} placeholder="production" />
            </div>
          </div>
          {host === 'custom' ? (
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://langfuse.example.com" className="font-mono text-xs" />
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <Input value={publicKey} onChange={(e) => setPublicKey(e.target.value)} placeholder="Public Key（pk-lf-…）" className="font-mono text-xs" />
            <Input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={lf.secretKeySet ? '已保存 Secret Key' : 'Secret Key（sk-lf-…）'}
              className="font-mono text-xs"
            />
          </div>
          <label className="flex items-center justify-between gap-4 text-sm">
            <span>
              上传页面截图
              <span className="block text-xs text-muted-foreground">关闭时截图会以占位文字代替，避免上传隐私页面</span>
            </span>
            <Switch checked={lf.includeScreenshots} onCheckedChange={(v) => void update({ langfuse: { ...lf, includeScreenshots: v } })} />
          </label>
          <div className="flex items-center justify-end gap-2">
            {result ? <span className={cn('mr-auto text-xs', result.ok ? 'text-success' : 'text-danger')}>{result.text}</span> : null}
            <Button variant="secondary" size="sm" loading={testing} disabled={!publicKey || (!lf.secretKeySet && !secret)} onClick={test}>
              测试连接
            </Button>
            <Button variant="primary" size="sm" disabled={!dirty} onClick={() => void save().then(() => toast.success('已保存 Langfuse 配置'))}>
              保存
            </Button>
          </div>
        </div>
      </Card>
    </>
  )
}

export function SettingsPage() {
  const { settings, update, load } = useSettings()
  const paths = useAsync(() => call('app.paths'))
  const [prompt, setPrompt] = useState('')
  const [lsKey, setLsKey] = useState('')
  const [lsProject, setLsProject] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!settings) load().catch((e) => setError(errorMessage(e)))
  }, [settings, load])

  useEffect(() => {
    if (settings) {
      setPrompt(settings.systemPrompt)
      setLsProject(settings.langsmithProject ?? '')
    }
  }, [settings])

  const patch = async (p: Partial<Settings> & { langsmithApiKey?: string }, msg?: string) => {
    try {
      await update(p)
      if (msg) toast.success(msg)
    } catch (e) {
      toast.error('保存失败', { description: errorMessage(e) })
    }
  }

  if (error)
    return (
      <Page>
        <ErrorState error={error} onRetry={() => void load()} />
      </Page>
    )
  if (!settings)
    return (
      <Page>
        <Skeleton className="mb-6 h-7 w-32" />
        <Skeleton className="h-64" />
      </Page>
    )

  return (
    <Page>
      <PageHeader title="设置" />

      <h2 className="mb-2 text-sm font-semibold">外观</h2>
      <Card className="mb-8">
        <Row title="主题" description="跟随系统或固定为浅色 / 深色">
          <div className="flex rounded-md border border-border bg-muted p-0.5">
            {(
              [
                ['system', Monitor, '系统'],
                ['light', Sun, '浅色'],
                ['dark', Moon, '深色'],
              ] as const
            ).map(([v, Icon, label]) => (
              <button
                key={v}
                onClick={() => void patch({ theme: v })}
                className={cn(
                  'interactive flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-xs',
                  settings.theme === v ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="size-3.5" />
                {label}
              </button>
            ))}
          </div>
        </Row>
      </Card>

      <h2 className="mb-2 text-sm font-semibold">Agent</h2>
      <Card className="mb-8 divide-y divide-border">
        <Row title="浏览器子代理" description="允许主 Agent 把多步骤网页任务委派给专门的 browser-operator 子代理，节省上下文">
          <Switch checked={settings.browserSubagent} onCheckedChange={(v) => void patch({ browserSubagent: v })} />
        </Row>
        <div className="px-5 py-4">
          <div className="text-sm font-medium">需要确认的操作</div>
          <div className="mt-0.5 mb-3 text-xs text-muted-foreground">Agent 执行以下工具前会暂停并请求你批准（后台任务不受影响）</div>
          <div className="grid grid-cols-2 gap-2">
            {APPROVAL_OPTIONS.map((o) => {
              const on = settings.approvalTools.includes(o.name)
              return (
                <label
                  key={o.name}
                  className="interactive flex cursor-pointer items-center justify-between rounded-md border border-border px-3 py-2 hover:bg-accent/50"
                >
                  <span>
                    <span className="text-sm">{o.label}</span>
                    <span className="block font-mono text-[11px] text-subtle-foreground">{o.name}</span>
                  </span>
                  <Switch
                    checked={on}
                    onCheckedChange={(v) =>
                      void patch({ approvalTools: v ? [...settings.approvalTools, o.name] : settings.approvalTools.filter((x) => x !== o.name) })
                    }
                  />
                </label>
              )
            })}
          </div>
        </div>
        <div className="px-5 py-4">
          <div className="text-sm font-medium">自定义指令</div>
          <div className="mt-0.5 mb-3 text-xs text-muted-foreground">追加到系统提示词，对所有对话生效</div>
          <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder="例如：回答尽量简洁；涉及金额时保留两位小数。" />
          <div className="mt-2 flex justify-end">
            <Button
              variant="primary"
              size="sm"
              disabled={prompt === settings.systemPrompt}
              onClick={() => void patch({ systemPrompt: prompt }, '已保存自定义指令')}
            >
              保存
            </Button>
          </div>
        </div>
      </Card>

      <LangfuseSection />

      <h2 className="mb-2 text-sm font-semibold">开发者</h2>
      <Card className="mb-8 divide-y divide-border">
        <Row title="开发者模式" description="记录运行轨迹、显示开发者页面与页面 DevTools 入口">
          <Switch checked={settings.devMode} onCheckedChange={(v) => void patch({ devMode: v })} />
        </Row>
        <div className={cn('px-5 py-4', !settings.devMode && 'opacity-50')}>
          <div className="text-sm font-medium">LangSmith 追踪</div>
          <div className="mt-0.5 mb-3 text-xs text-muted-foreground">可选。配置后在开发者模式下将运行轨迹上报到 LangSmith。</div>
          <div className="grid grid-cols-2 gap-3">
            <Input
              type="password"
              value={lsKey}
              onChange={(e) => setLsKey(e.target.value)}
              placeholder={settings.langsmithApiKeySet ? '已配置 API Key' : 'LangSmith API Key'}
              disabled={!settings.devMode}
              className="font-mono text-xs"
            />
            <Input value={lsProject} onChange={(e) => setLsProject(e.target.value)} placeholder="项目名" disabled={!settings.devMode} />
          </div>
          <div className="mt-2 flex justify-end gap-2">
            {settings.langsmithApiKeySet ? (
              <Button variant="ghost" size="sm" onClick={() => void patch({ langsmithApiKey: '' }, '已移除 API Key')} disabled={!settings.devMode}>
                移除密钥
              </Button>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              disabled={!settings.devMode || (!lsKey && lsProject === settings.langsmithProject)}
              onClick={async () => {
                await patch({ langsmithApiKey: lsKey || undefined, langsmithProject: lsProject }, '已保存 LangSmith 配置')
                setLsKey('')
              }}
            >
              保存
            </Button>
          </div>
        </div>
      </Card>

      <h2 className="mb-2 text-sm font-semibold">其他</h2>
      <Card className="mb-8">
        <Row title="首次使用引导" description="重新走一遍模型连接、能力导入与外观设置">
          <Button variant="secondary" size="sm" onClick={() => void patch({ onboarded: false })}>
            重新查看引导
          </Button>
        </Row>
      </Card>

      <h2 className="mb-2 text-sm font-semibold">数据位置</h2>
      <Card className="divide-y divide-border">
        {paths.data ? (
          (
            [
              ['应用数据', paths.data.userData],
              ['Skill', paths.data.skills],
              ['站点插件', paths.data.plugins],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="flex items-center gap-4 px-5 py-2.5">
              <span className="w-20 shrink-0 text-sm text-muted-foreground">{k}</span>
              <code className="selectable truncate font-mono text-xs">{v}</code>
            </div>
          ))
        ) : paths.error ? (
          <ErrorState error={paths.error} onRetry={paths.reload} compact className="m-3" />
        ) : (
          <div className="p-4">
            <Skeleton className="h-16" />
          </div>
        )}
      </Card>
    </Page>
  )
}
