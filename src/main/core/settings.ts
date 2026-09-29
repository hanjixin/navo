import { nativeTheme } from 'electron'
import type { LangfuseSettings, Settings } from '@shared/types'
import { kv } from './db'
import { emit } from './ipc'
import { secrets } from './secrets'

const DEFAULTS: Settings = {
  theme: 'system',
  devMode: false,
  systemPrompt: '',
  langsmithProject: 'navo',
  approvalTools: ['browser_eval', 'browser_upload_file'],
  browserSubagent: true,
  onboarded: false,
  mcpServer: { enabled: false, port: 38800, allowRun: true, allowWrite: false, allowMemory: false },
  files: { defaultEngine: 'builtin', ocr: true },
  memory: { enabled: true, autoLearn: true, review: false, daily: true, modelId: null },
  langfuse: {
    enabled: false,
    baseUrl: 'https://cloud.langfuse.com',
    publicKey: '',
    environment: 'production',
    includeScreenshots: false,
    projectId: null,
  },
}

export function getSettings(): Settings {
  const stored = kv.get<Partial<Settings>>('settings', {})
  return {
    ...DEFAULTS,
    ...stored,
    langfuse: { ...DEFAULTS.langfuse, ...(stored.langfuse ?? {}), secretKeySet: secrets.has('langfuse.secret') },
    mcpServer: { ...DEFAULTS.mcpServer, ...(stored.mcpServer ?? {}) },
    memory: { ...DEFAULTS.memory, ...(stored.memory ?? {}) },
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
  applyTracingEnv()
  const next = getSettings()
  emit('settings.changed', next)
  return next
}

/** LangSmith tracing is opt-in and only enabled in dev mode with a key configured. */
export function applyTracingEnv(): void {
  const s = getSettings()
  const key = secrets.get('langsmith')
  if (s.devMode && key) {
    process.env.LANGSMITH_TRACING = 'true'
    process.env.LANGSMITH_API_KEY = key
    process.env.LANGSMITH_PROJECT = s.langsmithProject || 'navo'
  } else {
    process.env.LANGSMITH_TRACING = 'false'
  }
}

/** Langfuse credentials for the agent process, or undefined when tracing is off / incomplete. */
export function langfuseConfig() {
  const { langfuse: l } = getSettings()
  const secretKey = secrets.get('langfuse.secret')
  if (!l.enabled || !l.publicKey || !secretKey) return undefined
  return {
    publicKey: l.publicKey,
    secretKey,
    baseUrl: l.baseUrl.replace(/\/+$/, ''),
    environment: l.environment || 'production',
    includeScreenshots: l.includeScreenshots,
    projectId: l.projectId ?? null,
  }
}

/** Verifies the keys against the Langfuse public API and caches the project id for trace links. */
export async function testLangfuse(): Promise<{ ok: boolean; projectId?: string; projectName?: string; error?: string }> {
  const { langfuse: l } = getSettings()
  const secretKey = secrets.get('langfuse.secret')
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
