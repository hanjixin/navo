import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { call } from '@/lib/ipc'
import { startRecording, type Recording } from '@/lib/recorder'
import { errorMessage } from '@/lib/utils'
import { t } from '@shared/i18n'

/** recordings stop by themselves after this long */
const MAX_MS = 120_000

export type VoiceState = 'idle' | 'starting' | 'recording' | 'transcribing'

/**
 * Voice input: start → speak → stop, and the text comes back through `onText`. Holding the button
 * records until it is released; a tap records until the next tap.
 */
export function useVoice(onText: (text: string) => void) {
  const [state, setState] = useState<VoiceState>('idle')
  const [level, setLevel] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  /** transcription is taking long (the local engine's first use downloads the model) */
  const [slow, setSlow] = useState(false)
  const rec = useRef<Recording | null>(null)
  const timer = useRef<number | null>(null)
  /** released before the microphone was ready: stop as soon as it is */
  const stopWhenReady = useRef(false)
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  const clear = () => {
    if (timer.current) window.clearInterval(timer.current)
    timer.current = null
    setLevel(0)
    setElapsed(0)
  }

  const stop = useCallback(async () => {
    const r = rec.current
    if (!r) {
      stopWhenReady.current = true
      return
    }
    rec.current = null
    clear()
    setState('transcribing')
    const slowTimer = window.setTimeout(() => setSlow(true), 8000)
    try {
      const wav = await r.stop()
      const { text } = await call('voice.transcribe', wav)
      if (text) onTextRef.current(text)
      else toast(t('没有听清，请再说一次'))
    } catch (e) {
      toast.error(t('语音识别失败'), { description: errorMessage(e) })
    } finally {
      window.clearTimeout(slowTimer)
      setSlow(false)
      setState('idle')
    }
  }, [])

  const start = useCallback(async () => {
    if (rec.current || state !== 'idle') return
    stopWhenReady.current = false
    setState('starting')
    try {
      const status = await call('voice.status')
      if (!status.ready) throw new Error(status.reason)
      if (!(await call('voice.prepare'))) throw new Error(t('没有麦克风权限：在「系统设置 → 隐私与安全性 → 麦克风」里允许 Navo'))
      rec.current = await startRecording()
      const began = Date.now()
      setState('recording')
      timer.current = window.setInterval(() => {
        setLevel(rec.current?.level() ?? 0)
        setElapsed(Date.now() - began)
        if (Date.now() - began > MAX_MS) void stop()
      }, 80)
      if (stopWhenReady.current) void stop()
    } catch (e) {
      rec.current = null
      clear()
      setState('idle')
      toast.error(t('无法开始语音输入'), { description: errorMessage(e) })
    }
  }, [state, stop])

  const cancel = useCallback(() => {
    rec.current?.cancel()
    rec.current = null
    clear()
    setState('idle')
  }, [])

  useEffect(() => () => rec.current?.cancel(), [])

  return { state, level, elapsed, slow, start, stop, cancel }
}
