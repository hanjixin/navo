import { useEffect, useState } from 'react'
import { Check, ChevronDown, Terminal, X } from 'lucide-react'
import { toast } from 'sonner'
import type { AgentRuntimeInfo, AgentRuntimeProfile, AgentRuntimeStatus } from '@shared/agent-runtime'
import { t } from '@shared/i18n'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input, Textarea } from '@/components/ui/input'
import { ErrorState, Skeleton } from '@/components/ui/states'
import { Switch } from '@/components/ui/switch'
import { call, on } from '@/lib/ipc'
import { errorMessage } from '@/lib/utils'
import { useRuntimes } from '@/stores/runtimes'

function RuntimeEditor({ info, reload }: { info: AgentRuntimeInfo; reload: () => Promise<void> }) {
  const [draft, setDraft] = useState<AgentRuntimeProfile>(info.profile)
  const [args, setArgs] = useState(JSON.stringify(info.profile.args))
  const [busy, setBusy] = useState<'save' | 'probe' | null>(null)
  const [error, setError] = useState('')
  const [status, setStatus] = useState<AgentRuntimeStatus | null>(null)
  const builtin = draft.kind === 'builtin'
  const pi = draft.kind === 'pi'
  const dirty = JSON.stringify(draft) !== JSON.stringify(info.profile) || args !== JSON.stringify(info.profile.args)
  const patch = (values: Partial<AgentRuntimeProfile>) => {
    setDraft((current) => ({ ...current, ...values }))
    setError('')
    setStatus(null)
  }
  const save = async () => {
    setError('')
    let parsed: unknown = []
    if (!pi) {
      try {
        parsed = JSON.parse(args)
      } catch {
        setError(t('启动参数必须是 JSON 字符串数组'))
        return
      }
      if (!Array.isArray(parsed) || parsed.some((argument) => typeof argument !== 'string')) {
        setError(t('启动参数必须是 JSON 字符串数组'))
        return
      }
    }
    if (!pi && !draft.command.trim()) {
      setError(t('请输入可执行文件或命令'))
      return
    }
    if (draft.kind === 'dsh' && draft.enabled && !draft.provider?.trim()) {
      setError(t('启用 DSH 前请填写 Provider'))
      return
    }
    setBusy('save')
    try {
      await call('runtimes.save', {
        ...draft,
        command: pi ? info.profile.command : draft.command.trim(),
        args: parsed as string[],
        model: draft.model?.trim() || undefined,
        provider: draft.provider?.trim() || undefined,
      })
      await reload()
      toast.success(t('已保存运行时配置'))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }
  const probe = async () => {
    setBusy('probe')
    setError('')
    try {
      setStatus(await call('runtimes.probe', draft.id))
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(null)
    }
  }
  const capabilities = [
    [t('Navo 工具'), info.capabilities.navoTools],
    [t('原生工具'), info.capabilities.nativeTools],
    [t('人工审批'), info.capabilities.approvals],
    [t('图片输入'), info.capabilities.images],
    [t('会话续接'), info.capabilities.resume],
  ] as const
  return (
    <details className="group border-t border-border first:border-t-0" data-testid={`runtime-${draft.kind}`}>
      <summary className="interactive flex cursor-pointer list-none items-center gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
        <Terminal className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 text-sm font-medium">{info.profile.name}</span>
        <span className="text-xs text-muted-foreground">{builtin ? t('内置') : info.profile.enabled ? t('已启用') : t('已停用')}</span>
        <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-4 px-5 pb-5">
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
          {capabilities.map(([label, supported]) => (
            <span key={label} className="inline-flex items-center gap-1">
              {supported ? <Check className="size-3 text-success" /> : <X className="size-3" />}
              {label}
            </span>
          ))}
        </div>
        {builtin ? (
          <p className="text-xs text-muted-foreground">{t('内置运行时始终可用，使用「模型」页配置及 Navo 工具。')}</p>
        ) : pi ? (
          <>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t('Pi 使用 Navo Agent Runtime，接入 Navo 工具、审批和模型配置。命令由应用内置管理。')}
            </p>
            <label className="flex items-center justify-between text-sm">
              {t('启用此运行时')}
              <Switch checked={draft.enabled} disabled={!!busy} onCheckedChange={(enabled) => patch({ enabled })} />
            </label>
            <p className="text-xs text-muted-foreground">{t('Pi 使用聊天框选择的 Navo 模型，可在已有会话中切换。')}</p>
            {error && (
              <p role="alert" className="text-xs break-words text-danger">
                {error}
              </p>
            )}
            <div className="flex items-center justify-end gap-2">
              <Button size="sm" variant="primary" onClick={() => void save()} disabled={!dirty || !!busy} loading={busy === 'save'}>
                {t('保存')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {draft.kind === 'claude'
                ? t('Claude 使用本机 CLI 登录，仅支持文本对话；原生工具、MCP 和 Hooks 已关闭。')
                : draft.kind === 'codex'
                  ? t('Codex 使用本机 CLI 登录，原生工具仅在只读沙箱内运行；MCP、浏览器和桌面集成已关闭。')
                  : t('外部运行时使用自己的模型与认证配置；第一版不接入 Navo 浏览器、桌面、插件或人工审批。')}
            </p>
            <label className="flex items-center justify-between text-sm">
              {t('启用此运行时')}
              <Switch checked={draft.enabled} disabled={!!busy} onCheckedChange={(enabled) => patch({ enabled })} />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs sm:col-span-2">
                <span>{t('可执行文件或命令')}</span>
                <Input value={draft.command} onChange={(event) => patch({ command: event.target.value })} disabled={!!busy} className="font-mono text-xs" />
              </label>
              <label className="space-y-1 text-xs sm:col-span-2">
                <span>{t('启动参数（JSON 数组）')}</span>
                <Textarea
                  value={args}
                  onChange={(event) => {
                    setArgs(event.target.value)
                    setError('')
                    setStatus(null)
                  }}
                  disabled={!!busy}
                  rows={2}
                  className="font-mono text-xs"
                  placeholder="[]"
                />
                <span className="block text-muted-foreground">{t('参数按原样传入，不经过 Shell。协议、会话和权限参数由 Navo 管理。')}</span>
              </label>
              <label className="space-y-1 text-xs">
                <span>{t('运行时模型')}</span>
                <Input
                  value={draft.model ?? ''}
                  onChange={(event) => patch({ model: event.target.value })}
                  disabled={!!busy}
                  placeholder={t('留空使用运行时默认模型')}
                  className="font-mono text-xs"
                />
              </label>
              {draft.kind !== 'claude' && (
                <label className="space-y-1 text-xs">
                  <span>{draft.kind === 'dsh' ? t('Provider（DSH 必填）') : 'Provider'}</span>
                  <Input
                    value={draft.provider ?? ''}
                    onChange={(event) => patch({ provider: event.target.value })}
                    disabled={!!busy}
                    placeholder={t('使用运行时中的 Provider 名称')}
                    className="font-mono text-xs"
                  />
                </label>
              )}
            </div>
            {error && (
              <p role="alert" className="text-xs break-words text-danger">
                {error}
              </p>
            )}
            {status && (
              <p role="status" className={`text-xs break-words ${status.available ? 'text-success' : 'text-danger'}`}>
                {status.available ? t('命令可用：{{version}}', { version: status.version ?? '' }) : status.error || t('命令不可用')}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{dirty ? t('保存后可检测命令') : t('检测仅执行 --version，不调用模型。')}</span>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => void probe()} disabled={dirty || !!busy} loading={busy === 'probe'}>
                  {t('检测命令')}
                </Button>
                <Button size="sm" variant="primary" onClick={() => void save()} disabled={!dirty || !!busy} loading={busy === 'save'}>
                  {t('保存')}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </details>
  )
}

export function RuntimeSection() {
  const { runtimes, error, load } = useRuntimes()
  useEffect(() => {
    void load()
    return on('runtimes.changed', () => void load())
  }, [load])
  return (
    <section className="mb-8" data-testid="runtime-settings">
      <h2 className="mb-2 text-sm font-semibold">{t('Agent 运行时')}</h2>
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        {t('运行时决定 Agent 如何执行任务。新建对话时选择；配置修改只应用于新对话，已有对话保留创建时的配置。')}
      </p>
      {error ? (
        <ErrorState error={error} onRetry={() => void load()} compact />
      ) : !runtimes ? (
        <Skeleton className="h-32" />
      ) : (
        <Card>
          {runtimes.map((info) => (
            <RuntimeEditor key={JSON.stringify(info.profile)} info={info} reload={load} />
          ))}
        </Card>
      )}
    </section>
  )
}
