import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createWorker, type Worker } from 'tesseract.js'
import { tidyCjkSpacing } from './text-utils'
import type { ParseOptions } from './types'

const LANGS = ['chi_sim', 'eng']

let worker: Promise<Worker> | null = null
let idleTimer: NodeJS.Timeout | null = null

/**
 * Shared Tesseract worker (Chinese simplified + English). The language data ships with the app
 * (`ocrLangDir`, 4.6 MB), so OCR works offline; only if it is missing is it downloaded from
 * jsDelivr once and cached in `ocrCacheDir`.
 */
async function getWorker(opts: Pick<ParseOptions, 'ocrCacheDir' | 'ocrLangDir' | 'onProgress'>): Promise<Worker> {
  if (!worker) {
    mkdirSync(opts.ocrCacheDir, { recursive: true })
    const bundled = opts.ocrLangDir && LANGS.every((l) => existsSync(join(opts.ocrLangDir!, `${l}.traineddata.gz`)))
    opts.onProgress?.(bundled ? '正在启动 OCR…' : '正在准备 OCR（首次使用需下载中文语言包）…')
    worker = createWorker(LANGS.join('+'), 1, { cachePath: opts.ocrCacheDir, ...(bundled ? { langPath: opts.ocrLangDir, gzip: true } : {}) }).catch((err) => {
      worker = null
      throw new Error(`OCR 引擎初始化失败${bundled ? '' : '（需要联网下载语言包）'}：${(err as Error).message ?? err}`)
    })
  }
  return worker
}

/** Frees the ~100 MB worker after a minute of inactivity. */
function scheduleIdle(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    void worker?.then((w) => w.terminate())
    worker = null
  }, 60_000)
}

export interface OcrResult {
  text: string
  confidence: number
}

/** Recognises text in an image; returns paragraphs separated by blank lines. */
export async function ocrImage(image: Buffer, opts: Pick<ParseOptions, 'ocrCacheDir' | 'ocrLangDir' | 'onProgress'>): Promise<OcrResult> {
  const w = await getWorker(opts)
  try {
    const { data } = await w.recognize(image)
    // keep Tesseract's line structure (forms, lists and headings are line-based); blank lines separate blocks
    const text = tidyCjkSpacing(
      data.text
        .split(/\n{2,}/)
        .map((p) =>
          p
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .join('\n'),
        )
        .filter(Boolean)
        .join('\n\n'),
    )
    return { text, confidence: data.confidence }
  } finally {
    scheduleIdle()
  }
}

export async function shutdownOcr(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer)
  await worker?.then((w) => w.terminate()).catch(() => undefined)
  worker = null
}
