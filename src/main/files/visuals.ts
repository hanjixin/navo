import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCanvas, loadImage } from '@napi-rs/canvas'

/**
 * Model-ready copies of visual content, written next to the original while parsing:
 * `image.jpg` for pictures, `page-<n>.jpg` for scanned PDF pages, `thumb.jpg` for the UI.
 * Long edge ≤ 2000px keeps images within every provider's limits (Anthropic downsizes above ~1568,
 * OpenAI tiles up to 2048) while text in screenshots stays legible.
 */
export const VISION_MAX_EDGE = 2000
/** at most this many scanned pages are kept as images */
export const MAX_PAGE_VISUALS = 10
const THUMB_EDGE = 160

async function jpeg(src: Buffer, maxEdge: number, quality: number): Promise<Buffer> {
  const img = await loadImage(src)
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height))
  const w = Math.max(1, Math.round(img.width * scale))
  const h = Math.max(1, Math.round(img.height * scale))
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  // transparent PNGs would turn black in JPEG
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(img, 0, 0, w, h)
  return canvas.encode('jpeg', quality)
}

/** Writes `<name>.jpg` (and the thumbnail if missing); returns false when the image can't be decoded. */
export async function writeVisual(src: Buffer, dir: string, name: string, thumb = true): Promise<boolean> {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${name}.jpg`), await jpeg(src, VISION_MAX_EDGE, 85))
    if (thumb) writeFileSync(join(dir, 'thumb.jpg'), await jpeg(src, THUMB_EDGE * 2, 80))
    return true
  } catch {
    return false
  }
}
