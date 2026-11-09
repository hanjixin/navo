import { ArrowUp, Loader2, Mic, Paperclip, Square, X } from 'lucide-react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { AttachmentChip } from '@/components/files/attachment-chip'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Tooltip } from '@/components/ui/tooltip'
import { cn, errorMessage } from '@/lib/utils'
import { useDrafts, draftKey } from '@/stores/drafts'
import type { DraftScope } from '@shared/reliability'
import { useFiles } from '@/stores/files'
import { useModels } from '@/stores/models'
import { useRuntimes, wireRuntimeEvents } from '@/stores/runtimes'
import { useSettings } from '@/stores/settings'
import { useVoice } from '@/hooks/use-voice'
import { t } from '@shared/i18n'

export function Composer({
  onSend,
  draftScope,
  onStop,
  running,
  modelId,
  runtimeId: fixedRuntimeId,
  onModelChange,
  disabled,
  disabledReason,
  value,
  onValueChange,
  placeholder,
  className,
  minHeight = 0,
  showModelManagementLink = true,
}: {
  onSend: (text: string, fileIds: string[]) => Promise<void>
  draftScope: DraftScope
  onStop: () => void
  running: boolean
  modelId: string | null
  runtimeId?: string
  onModelChange: (id: string) => void
  disabled?: boolean
  disabledReason?: string
  value?: string
  onValueChange?: (text: string) => void
  placeholder?: string
  className?: string
  minHeight?: number
  showModelManagementLink?: boolean
}) {
  const [localText, setLocalText] = useState('')
  const text = value ?? localText
  const setText = onValueChange ?? setLocalText
  const draft = useDrafts((s) => s.entries[draftKey(draftScope)])
  const runtimes = useRuntimes((s) => s.runtimes)
  const runtimesError = useRuntimes((s) => s.error)
  const loadRuntimes = useRuntimes((s) => s.load)
  const runtimeId = fixedRuntimeId ?? draft?.data.runtimeId ?? 'builtin'
  const external = runtimeId !== 'builtin' && runtimeId !== 'pi'
  const runtime = runtimes?.find((item) => item.profile.id === runtimeId)
  const runtimeUnavailable = runtimeId !== 'builtin' && (!runtime?.profile.enabled || !runtimes)
  useEffect(() => {
    wireRuntimeEvents()
    void loadRuntimes()
  }, [loadRuntimes])
  const attached = draft?.data.fileIds ?? []
  const projectFiles = draft?.data.projectFiles ?? []
  const setAttached = (fileIds: string[]) => useDrafts.getState().patch(draftScope, { fileIds })
  const [submitting, setSubmitting] = useState(false)
  const submitLock = useRef(false)
  const { addFiles: upload, pick } = useFiles()
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const models = useModels((s) => s.activeModels) ?? []
  const modelsLoaded = useModels((s) => s.activeModels !== undefined)
  const current = modelId ? models.find((m) => m.id === modelId) : (models.find((m) => m.isDefault) ?? models[0])
  const modelUnavailable = !external && modelsLoaded && !current
  const modelReason = models.length ? t('当前模型已停用或不可用，请切换模型') : t('没有已启用的模型，请前往模型页面启用')

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, minHeight), 220)}px`
  }, [text, minHeight])

  const submit = async (override?: string) => {
    const body = (override ?? text).trim()
    if (
      (!body && !attached.length && !projectFiles.length) ||
      running ||
      disabled ||
      modelUnavailable ||
      (!external && !modelsLoaded) ||
      runtimeUnavailable ||
      submitLock.current
    )
      return
    if (override !== undefined) setText(override)
    submitLock.current = true
    setSubmitting(true)
    try {
      await onSend(body, attached)
    } catch (e) {
      toast.error(t('提交失败'), { description: errorMessage(e) })
    } finally {
      submitLock.current = false
      setSubmitting(false)
    }
  }

  // ---------- voice input
  const autoSend = useSettings((s) => s.settings?.voice.autoSend ?? false)
  const loadSettings = useSettings((s) => s.load)
  const hasSettings = useSettings((s) => !!s.settings)
  useEffect(() => {
    if (!hasSettings) void loadSettings()
  }, [hasSettings, loadSettings])
  const voice = useVoice((said) => {
    const next = text.trim() ? `${text.trimEnd()} ${said}` : said
    if (autoSend && !running) void submit(next)
    else {
      setText(next)
      requestAnimationFrame(() => ref.current?.focus())
    }
  })
  const press = useRef({ at: 0, started: false })
  /** holding records until release; a tap starts, the next tap stops */
  const micDown = () => {
    press.current = { at: Date.now(), started: voice.state === 'idle' }
    if (press.current.started) void voice.start()
  }
  const micUp = () => {
    const { at, started } = press.current
    press.current = { at: 0, started: false }
    if (!at) return
    // the press that started it: stop only if it was held; any later press: stop
    if (!started || Date.now() - at > 400) void voice.stop()
  }
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (disabled) return
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault()
        if (voice.state === 'idle') void voice.start()
        else if (voice.state === 'recording') void voice.stop()
      } else if (e.key === 'Escape' && voice.state === 'recording') voice.cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [disabled, voice])

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  const attach = (ids: string[]) => useDrafts.getState().addFiles(draftScope, ids)

  /** Any file type: parsed in the background while the user keeps typing. */
  const addFiles = async (files: FileList | null) => {
    const list = Array.from(files ?? [])
    if (!list.length) return
    try {
      await attach((await upload(list)).map((r) => r.id))
    } catch (e) {
      toast.error(t('添加文件失败'), { description: errorMessage(e) })
    }
  }

  return (
    <div
      className={cn(
        'interactive rounded-lg border bg-card focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-ring',
        dragging ? 'border-primary bg-info-soft' : 'border-input',
        className,
      )}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        void addFiles(e.dataTransfer.files)
      }}
    >
      {external ? (
        <div className="px-3.5 pt-3 text-xs text-muted-foreground" role="status">
          <p>{t('外部运行时使用本机配置，暂不支持 Navo 工具、审批和图片输入。')}</p>
          {runtime?.capabilities.nativeTools ? <p>{t('此运行时可执行自己的本机工具。')}</p> : null}
          {runtimeUnavailable ? <p className="text-danger">{t('运行时未启用或不可用，请在设置中检查。')}</p> : null}
        </div>
      ) : null}
      {runtimesError ? (
        <p role="alert" className="px-3.5 pt-2 text-xs text-danger">
          {t('运行时列表加载失败：{{error}}', { error: runtimesError })}
        </p>
      ) : null}
      {modelUnavailable ? (
        <div className="flex flex-wrap items-center gap-2 px-3.5 pt-3 text-xs text-muted-foreground" role="status">
          <span>{modelReason}</span>
          {!models.length && showModelManagementLink ? (
            <Link to="/models" className="interactive rounded text-brand hover:underline">
              {t('管理模型')}
            </Link>
          ) : null}
        </div>
      ) : null}
      {draft?.error ? (
        <p role="alert" className="px-3 pt-2 text-xs text-danger">
          {t('草稿尚未保存：{{v0}}', { v0: draft.error })}
        </p>
      ) : null}
      {projectFiles.length ? (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {projectFiles.map((file) => (
            <span
              key={JSON.stringify(file)}
              className="flex max-w-full items-center gap-2 rounded-md border border-border px-2 py-1 text-xs"
              title={`${file.root}/${file.path}`}
            >
              <Paperclip className="size-3 shrink-0" />
              <span className="truncate">{file.path}</span>
              <span className="shrink-0 text-muted-foreground">{t('发送时读取')}</span>
              <button
                aria-label={t('移除 {{v0}}', { v0: file.path })}
                onClick={() => useDrafts.getState().patch(draftScope, { projectFiles: projectFiles.filter((item) => item !== file) })}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {attached.length ? (
        <div className="flex flex-wrap gap-2 px-3 pt-3">
          {attached.map((id) => (
            <AttachmentChip key={id} id={id} onRemove={() => setAttached(attached.filter((x) => x !== id))} />
          ))}
        </div>
      ) : null}
      <textarea
        ref={ref}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onPaste={(e) => {
          if (e.clipboardData.files.length) {
            e.preventDefault()
            void addFiles(e.clipboardData.files)
          }
        }}
        disabled={disabled}
        placeholder={
          disabled
            ? (disabledReason ?? t('暂不可输入'))
            : dragging
              ? t('松开以添加文件')
              : (placeholder ?? t('描述你想完成的任务，可拖入或粘贴文件；Enter 发送，Shift+Enter 换行'))
        }
        className="block max-h-[220px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm leading-relaxed outline-none placeholder:text-subtle-foreground"
      />
      <div className="flex items-center gap-1.5 px-2 pt-1 pb-2">
        {voice.state === 'recording' || voice.state === 'transcribing' ? (
          <div
            data-testid="voice-bar"
            className="flex h-7 min-w-0 flex-1 animate-fade-in items-center gap-2 rounded-md bg-muted px-2.5 text-xs text-muted-foreground"
          >
            {voice.state === 'recording' ? (
              <>
                <span className="size-2 shrink-0 animate-pulse rounded-full bg-danger" />
                <span>{t('正在听')}</span>
                <span className="flex h-3.5 items-center gap-0.5" aria-hidden>
                  {[0.6, 1, 0.75, 0.9, 0.5].map((k, i) => (
                    <span
                      key={i}
                      className="w-0.5 rounded-full bg-brand transition-[height] duration-75"
                      style={{ height: `${Math.max(15, voice.level * k * 100)}%` }}
                    />
                  ))}
                </span>
                <span className="tabular-nums">{Math.floor(voice.elapsed / 1000)}″</span>
                <span className="ml-auto truncate text-subtle-foreground">{t('松开或再点一次完成 · Esc 取消')}</span>
                <Button variant="ghost" size="icon-sm" className="size-6" aria-label={t('取消录音')} onClick={voice.cancel}>
                  <X />
                </Button>
              </>
            ) : (
              <>
                <Loader2 className="size-3.5 shrink-0 animate-spin" />
                <span className="truncate">{voice.slow ? t('正在识别…第一次使用本机识别时要先下载模型，可能需要几分钟') : t('正在识别…')}</span>
              </>
            )}
          </div>
        ) : (
          <>
            <Tooltip content={t('添加文件（PDF、Word、Excel、PPT、图片、代码…）')} side="top">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() =>
                  void pick().then(
                    (recs) => attach(recs.map((r) => r.id)),
                    (e) => toast.error(t('添加文件失败'), { description: errorMessage(e) }),
                  )
                }
                aria-label={t('添加文件')}
                disabled={disabled}
              >
                <Paperclip />
              </Button>
            </Tooltip>
            <div className="max-w-44 min-w-0" data-testid="composer-runtime">
              {draftScope.threadId ? (
                <span
                  className="inline-block max-w-full truncate rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
                  title={t('会话创建后不可切换运行时')}
                >
                  {runtime?.profile.name ?? (runtimeId === 'builtin' ? 'Navo' : runtimeId)}
                </span>
              ) : (
                <Select
                  value={runtimeId}
                  onChange={(runtimeId) => useDrafts.getState().patch(draftScope, { runtimeId })}
                  disabled={running || submitting || disabled}
                  placeholder={t('选择运行时')}
                  className="h-7 border-transparent bg-transparent text-xs text-muted-foreground hover:bg-accent"
                  options={(runtimes ?? [])
                    .filter((item) => item.profile.enabled || item.profile.id === runtimeId)
                    .map((item) => ({ value: item.profile.id, label: item.profile.name }))}
                />
              )}
            </div>
            {external ? (
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {draftScope.threadId ? t('使用创建时的运行时配置') : (runtime?.profile.model ?? t('使用运行时默认模型'))}
              </span>
            ) : null}
            {!external && models.length ? (
              <div className="max-w-52 min-w-0 flex-1">
                <Select
                  value={current?.id ?? ''}
                  placeholder={t('请选择已启用的模型')}
                  onChange={onModelChange}
                  className="h-7 border-transparent bg-transparent text-xs text-muted-foreground hover:bg-accent"
                  options={models.map((m) => ({ value: m.id, label: m.displayName }))}
                />
              </div>
            ) : null}
          </>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          <Tooltip content={voice.state === 'recording' ? t('完成录音') : t('语音输入：按住说话，或点一下开始 · ⌘⇧M')} side="top">
            <Button
              variant={voice.state === 'recording' ? 'secondary' : 'ghost'}
              size="icon-sm"
              aria-label={voice.state === 'recording' ? t('完成录音') : t('语音输入')}
              aria-pressed={voice.state === 'recording'}
              disabled={disabled || voice.state === 'starting' || voice.state === 'transcribing'}
              onPointerDown={(e) => {
                // the release comes back here even if the pointer has moved off the button
                e.currentTarget.setPointerCapture(e.pointerId)
                micDown()
              }}
              onPointerUp={micUp}
              onPointerCancel={micUp}
              className={cn(voice.state === 'recording' && 'text-danger')}
            >
              {voice.state === 'recording' ? <Square className="size-3 fill-current" /> : <Mic />}
            </Button>
          </Tooltip>
          {running ? (
            <Tooltip content={t('停止')} side="top">
              <Button variant="secondary" size="icon-sm" onClick={onStop} aria-label={t('停止')}>
                <Square className="size-3 fill-current" />
              </Button>
            </Tooltip>
          ) : (
            <Button
              variant="primary"
              size="icon-sm"
              onClick={() => void submit()}
              disabled={
                disabled ||
                submitting ||
                modelUnavailable ||
                (!external && !modelsLoaded) ||
                runtimeUnavailable ||
                (!text.trim() && !attached.length && !projectFiles.length)
              }
              aria-label={t('发送')}
              className={cn('rounded-md')}
            >
              <ArrowUp />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
