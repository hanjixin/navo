import { app, nativeTheme } from 'electron'
import { win32 } from 'node:path'
import type { LangfuseSettings, Settings } from '@shared/types'
import { kv } from './db'
import { emit } from './ipc'
import { secrets } from './secrets'
import type { TracingIntegrationStatus } from '@shared/tracing'
import { t } from '@shared/i18n'

const DEFAULTS: Settings = {
  theme: 'system',
  language: 'system',
  devMode: false,
  systemPrompt: '',
  langsmithProject: 'navo',
  approvalTools: ['browser_eval', 'browser_upload_file'],
  browserSubagent: true,
  onboarded: false,
  mcpServer: { enabled: false, port: 38800, allowRun: true, allowWrite: false, allowMemory: false },
  files: { defaultEngine: 'builtin', ocr: true },
  quick: { enabled: true, shortcut: 'Alt+Space', screenshotShortcut: 'Alt+Shift+Space', keepInTray: true },
  usage: { dailyBudget: null, currency: 'CNY', pauseBackground: false },
  voice: { engine: 'provider', providerId: null, model: 'whisper-1', localModel: 'small', language: 'auto', autoSend: false },
  computerUse: {
    desktop: false,
    myBrowser: false,
    // System settings, command shells, and Navo itself (Electron when run from source).
    blockedApps:
      process.platform === 'win32'
        ? [
            process.execPath,
            win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'ImmersiveControlPanel', 'SystemSettings.exe'),
            win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
            win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
            win32.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
          ]
        : ['com.apple.keychainaccess', 'com.apple.systempreferences', 'com.apple.Terminal', 'com.navo.app', ...(app.isPackaged ? [] : ['com.github.Electron'])],
  },
  skills: { selfImprove: true, autoApplySmall: true, autoCreateFromExperience: true },
  memory: { enabled: true, autoLearn: true, review: false, daily: true, modelId: null, idleMinutes: 3, consolidate: true },
  langfuse: {
    enabled: false,
    baseUrl: 'https://cloud.langfuse.com',
    publicKey: '',
    environment: 'production',
    includeScreenshots: false,
    projectId: null,
  },
}

let languageHook: (() => void) | null = null
/** set by core/language (avoids an import cycle): runs when the language setting changes */
export function onLanguageChange(fn: () => void): void {
  languageHook = fn
}

export function getSettings(): Settings {
  const stored = kv.get<Partial<Settings>>('settings', {})
  return {
    ...DEFAULTS,
    ...stored,
    langfuse: { ...DEFAULTS.langfuse, ...(stored.langfuse ?? {}), secretKeySet: secrets.has('langfuse.secret') },
    mcpServer: { ...DEFAULTS.mcpServer, ...(stored.mcpServer ?? {}) },
    memory: { ...DEFAULTS.memory, ...(stored.memory ?? {}) },
    skills: { ...DEFAULTS.skills, ...(stored.skills ?? {}) },
    quick: { ...DEFAULTS.quick, ...(stored.quick ?? {}) },
    usage: { ...DEFAULTS.usage, ...(stored.usage ?? {}) },
    voice: { ...DEFAULTS.voice, ...(stored.voice ?? {}) },
    computerUse: { ...DEFAULTS.computerUse, ...(stored.computerUse ?? {}) },
    files: { ...DEFAULTS.files, ...(stored.files ?? {}), mineruTokenSet: secrets.has('mineru.token') },
    langsmithApiKeySet: secrets.has('langsmith'),
  }
}

export function setSettings(patch: Partial<Settings> & { langsmithApiKey?: string; langfuseSecretKey?: string; mineruToken?: string }): Settings {
  const { langsmithApiKey, langfuseSecretKey, mineruToken, langsmithApiKeySet: _ignored, ...rest } = patch
  if (mineruToken !== undefined) {
    if (mineruToken) secrets.set('mineru.token', mineruToken)
    else secrets.delete('mineru.token')
  }
  if (langsmithApiKey !== undefined) {
    if (langsmithApiKey) secrets.set('langsmith', langsmithApiKey)
    else secrets.delete('langsmith')
  }
  if (langfuseSecretKey !== undefined) {
    if (langfuseSecretKey) secrets.set('langfuse.secret', langfuseSecretKey)
    else secrets.delete('langfuse.secret')
  }
  const { langsmithApiKeySet: _s, ...current } = getSettings()
  const langfuse: LangfuseSettings = { ...current.langfuse, ...(rest.langfuse ?? {}) }
  delete langfuse.secretKeySet
  // a different project/host invalidates the cached project id used for trace links
  if (rest.langfuse && (rest.langfuse.baseUrl !== undefined || rest.langfuse.publicKey !== undefined) && rest.langfuse.projectId === undefined)
    langfuse.projectId = null
  kv.set('settings', { ...current, ...rest, langfuse })
  if (rest.theme) nativeTheme.themeSource = rest.theme
  if (rest.language) languageHook?.()
  applyTracingEnv()
  const next = getSettings()
  emit('settings.changed', next)
  return next
}

const integrationStatus: TracingIntegrationStatus = {
  langsmith: { state: 'disabled' },
  langfuse: { state: 'disabled' },
}

function setIntegrationStatus(key: keyof TracingIntegrationStatus, status: TracingIntegrationStatus['langsmith']): void {
  if (JSON.stringify(integrationStatus[key]) === JSON.stringify(status)) return
  integrationStatus[key] = status
  emit('integrations.changed')
}

/** Diagnostics contain no credentials and do not attempt decryption. */
export function getIntegrationStatus(): TracingIntegrationStatus {
  return { langsmith: { ...integrationStatus.langsmith }, langfuse: { ...integrationStatus.langfuse } }
}

function clearLangsmithEnv(): void {
  process.env.LANGSMITH_TRACING = 'false'
  process.env.LANGCHAIN_TRACING_V2 = 'false'
  for (const name of ['LANGSMITH_API_KEY', 'LANGSMITH_PROJECT', 'LANGCHAIN_API_KEY', 'LANGCHAIN_PROJECT']) delete process.env[name]
}

function clearLangfuseEnv(): void {
  for (const name of ['LANGFUSE_SECRET_KEY', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_HOST', 'LANGFUSE_BASE_URL']) delete process.env[name]
}

/** Optional integrations must never prevent startup or an ordinary conversation. */
export function applyTracingEnv(): void {
  const s = getSettings()
  clearLangsmithEnv()
  if (!s.devMode) setIntegrationStatus('langsmith', { state: 'disabled' })
  else {
    try {
      const key = secrets.get('langsmith')
      if (key) {
        process.env.LANGSMITH_TRACING = 'true'
        process.env.LANGSMITH_API_KEY = key
        process.env.LANGSMITH_PROJECT = s.langsmithProject || 'navo'
        setIntegrationStatus('langsmith', { state: 'ready' })
      } else setIntegrationStatus('langsmith', { state: 'unconfigured' })
    } catch {
      setIntegrationStatus('langsmith', { state: 'error', error: t('追踪密钥无法读取，已暂停此集成。请重新配置密钥。') })
    }
  }
  // Diagnose Langfuse independently; a broken key in either integration leaves the other usable.
  langfuseConfig()
}

/** Langfuse credentials for the agent process, or undefined when tracing is off / incomplete. */
export function langfuseConfig() {
  const { langfuse: l } = getSettings()
  clearLangfuseEnv()
  if (!l.enabled) {
    setIntegrationStatus('langfuse', { state: 'disabled' })
    return undefined
  }
  if (!l.publicKey) {
    setIntegrationStatus('langfuse', { state: 'unconfigured' })
    return undefined
  }
  try {
    const secretKey = secrets.get('langfuse.secret')
    if (!secretKey) {
      setIntegrationStatus('langfuse', { state: 'unconfigured' })
      return undefined
    }
    setIntegrationStatus('langfuse', { state: 'ready' })
    return {
      publicKey: l.publicKey,
      secretKey,
      baseUrl: l.baseUrl.replace(/\/+$/, ''),
      environment: l.environment || 'production',
      includeScreenshots: l.includeScreenshots,
      projectId: l.projectId ?? null,
    }
  } catch {
    setIntegrationStatus('langfuse', { state: 'error', error: t('追踪密钥无法读取，已暂停此集成。请重新配置密钥。') })
    return undefined
  }
}

/** Verifies the keys against the Langfuse public API and caches the project id for trace links. */
export async function testLangfuse(): Promise<{ ok: boolean; projectId?: string; projectName?: string; error?: string }> {
  const { langfuse: l } = getSettings()
  let secretKey: string | null
  try {
    secretKey = secrets.get('langfuse.secret')
  } catch {
    const error = t('追踪密钥无法读取，已暂停此集成。请重新配置密钥。')
    setIntegrationStatus('langfuse', { state: 'error', error })
    clearLangfuseEnv()
    return { ok: false, error }
  }
  if (!l.publicKey || !secretKey) return { ok: false, error: '请填写 Public Key 和 Secret Key' }
  try {
    const res = await fetch(`${l.baseUrl.replace(/\/+$/, '')}/api/public/projects`, {
      headers: { Authorization: `Basic ${Buffer.from(`${l.publicKey}:${secretKey}`).toString('base64')}` },
      signal: AbortSignal.timeout(10000),
    })
    if (res.status === 401) return { ok: false, error: '密钥无效（401），请检查 Public Key / Secret Key 与区域是否匹配' }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const body = (await res.json()) as { data?: { id: string; name: string }[] }
    const project = body.data?.[0]
    setSettings({ langfuse: { ...l, projectId: project?.id ?? null } })
    return { ok: true, projectId: project?.id, projectName: project?.name }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
