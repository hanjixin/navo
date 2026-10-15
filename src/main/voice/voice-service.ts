import { app, systemPreferences } from 'electron'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fullWidthPunctuation } from '@shared/cjk'
import type { Provider, VoiceStatus } from '@shared/types'
import { log } from '../core/logger'
import { getSettings } from '../core/settings'
import { shellPath } from '../core/shell-env'
import { providers } from '../models/registry'
import { t } from '@shared/i18n'

/** Anthropic has no speech-to-text endpoint; OpenAI and OpenAI-compatible services do */
const canTranscribe = (p: Provider) => p.type !== 'anthropic'

/** Chinese hint: simplified characters with punctuation (Whisper otherwise often drops punctuation) */
const ZH_PROMPT = '以下是普通话的句子，使用简体中文和标点符号。'

/**
 * Voice input: what was said, as text. Either a provider's /audio/transcriptions (OpenAI Whisper,
 * SiliconFlow SenseVoice…) or faster-whisper on this machine (uvx whisper-ctranslate2; the first
 * use downloads the engine and the model).
 */
class VoiceService {
  private provider(): Provider | null {
    const { providerId } = getSettings().voice
    const all = providers.list().filter(canTranscribe)
    return (providerId ? all.find((p) => p.id === providerId) : all[0]) ?? null
  }

  status(): VoiceStatus {
    const v = getSettings().voice
    if (v.engine === 'local') return { ready: true, engine: 'local', label: t('本机 faster-whisper · {{v0}}（录音不离开这台电脑）', { v0: v.localModel }) }
    const p = this.provider()
    if (!p) return { ready: false, engine: 'provider', reason: '在「设置 → 语音输入」选择识别服务：OpenAI 兼容的服务商，或本机识别' }
    if (!v.model.trim()) return { ready: false, engine: 'provider', reason: '在「设置 → 语音输入」填写识别模型' }
    return { ready: true, engine: 'provider', label: `${p.name} · ${v.model}` }
  }

  /** macOS asks once for the microphone; tests run with Chromium's fake device and skip it */
  async prepare(): Promise<boolean> {
    if (process.platform !== 'darwin' || app.commandLine.hasSwitch('use-fake-device-for-media-stream')) return true
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true
    return systemPreferences.askForMediaAccess('microphone')
  }

  async transcribe(wav: Uint8Array): Promise<{ text: string }> {
    if (wav.byteLength < 1000) throw new Error(t('没有录到声音'))
    const v = getSettings().voice
    const text = v.engine === 'local' ? await this.local(Buffer.from(wav), v.localModel, v.language) : await this.remote(Buffer.from(wav), v.model, v.language)
    return { text: fullWidthPunctuation(text.trim()) }
  }

  private async remote(wav: Buffer, model: string, language: string): Promise<string> {
    const p = this.provider()
    if (!p) throw new Error(this.status().reason)
    const base = (p.baseURL || 'https://api.openai.com/v1').replace(/\/+$/, '')
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'speech.wav')
    form.append('model', model)
    if (language !== 'auto') form.append('language', language)
    if (language !== 'en') form.append('prompt', ZH_PROMPT)
    const key = providers.apiKey(p.id)
    const res = await fetch(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(p.headers ?? {}) },
      body: form,
      signal: AbortSignal.timeout(60_000),
    })
    const body = await res.text()
    if (!res.ok) {
      const msg = (() => {
        try {
          return JSON.parse(body).error?.message ?? body
        } catch {
          return body
        }
      })()
      throw new Error(
        res.status === 404 ? t('{{v0}} 不支持语音识别（/audio/transcriptions）', { v0: p.name }) : t('语音识别失败：{{v0}}', { v0: String(msg).slice(0, 200) }),
      )
    }
    try {
      return JSON.parse(body).text ?? ''
    } catch {
      return body
    }
  }

  private local(wav: Buffer, model: string, language: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'navo-voice-'))
    const file = join(dir, 'speech.wav')
    writeFileSync(file, wav)
    const args = [
      '--from',
      'whisper-ctranslate2',
      'whisper-ctranslate2',
      file,
      '--model',
      model,
      '--output_dir',
      dir,
      '--output_format',
      'txt',
      '--device',
      'cpu',
      '--compute_type',
      'int8',
    ]
    if (language !== 'auto') args.push('--language', language)
    if (language !== 'en') args.push('--initial_prompt', ZH_PROMPT)
    return new Promise<string>((resolve, reject) => {
      execFile('uvx', args, { env: { ...process.env, PATH: shellPath() }, timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) => {
        try {
          if (err) {
            const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
            log.warn(`[voice] local engine failed: ${stderr.slice(-500)}`)
            reject(
              new Error(
                missing
                  ? t('本机识别需要 uv：先安装 uv（https://docs.astral.sh/uv/），或改用服务商识别')
                  : t('本机识别失败：{{v0}}', { v0: stderr.trim().split('\n').pop() ?? err.message }),
              ),
            )
            return
          }
          resolve(readFileSync(join(dir, 'speech.txt'), 'utf8'))
        } catch (e) {
          reject(e as Error)
        } finally {
          rmSync(dir, { recursive: true, force: true })
        }
      })
    })
  }
}

export const voice = new VoiceService()
