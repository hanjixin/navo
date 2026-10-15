import { encodeWav } from '@shared/wav'

/**
 * Microphone recording for voice input: MediaRecorder while speaking, then 16 kHz mono WAV — the
 * format every speech service and Whisper accept, and small (32 KB/s).
 */
export interface Recording {
  /** 0..1, for the level meter */
  level: () => number
  stop: () => Promise<Uint8Array>
  cancel: () => void
}

export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } })
  const ctx = new AudioContext()
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 512
  ctx.createMediaStreamSource(stream).connect(analyser)
  const buf = new Uint8Array(analyser.fftSize)
  const chunks: Blob[] = []
  const rec = new MediaRecorder(stream)
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  rec.start(250)
  const release = () => {
    stream.getTracks().forEach((t) => t.stop())
    void ctx.close()
  }
  return {
    level: () => {
      analyser.getByteTimeDomainData(buf)
      let peak = 0
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128))
      return Math.min(1, peak / 64)
    },
    stop: () =>
      new Promise<Uint8Array>((resolve, reject) => {
        rec.onstop = async () => {
          release()
          try {
            resolve(await toWav(new Blob(chunks, { type: rec.mimeType })))
          } catch (e) {
            reject(e)
          }
        }
        rec.stop()
      }),
    cancel: () => {
      rec.onstop = null
      if (rec.state !== 'inactive') rec.stop()
      release()
    },
  }
}

const RATE = 16000

async function toWav(blob: Blob): Promise<Uint8Array> {
  const decoded = await new AudioContext().decodeAudioData(await blob.arrayBuffer())
  // mix down and resample in one pass
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * RATE)), RATE)
  const src = offline.createBufferSource()
  src.buffer = decoded
  src.connect(offline.destination)
  src.start()
  const pcm = (await offline.startRendering()).getChannelData(0)
  return encodeWav(pcm, RATE)
}
