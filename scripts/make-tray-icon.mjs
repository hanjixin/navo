// Renders the menu-bar icon (macOS template image: black + alpha, the system tints it) from the logo's
// pointer + spark shapes, at 1x and 2x.   node scripts/make-tray-icon.mjs
import { createCanvas, Path2D } from '@napi-rs/canvas'
import { writeFileSync } from 'node:fs'

for (const [scale, suffix] of [
  [1, ''],
  [2, '@2x'],
]) {
  const size = 18 * scale
  const c = createCanvas(size, size)
  const g = c.getContext('2d')
  // logo coordinates (64-unit box, content around 19..53 × 11..49) → fit into the icon
  g.scale(size / 40, size / 40)
  g.translate(-15.5, -10)
  g.fillStyle = '#000'
  g.strokeStyle = '#000'
  g.lineJoin = 'round'
  g.lineWidth = 2.5
  const pointer = new Path2D('M19 15 L19 45 L27 38 L32 49 L36.5 47 L31.5 36.5 L41 36.5 Z')
  g.fill(pointer)
  g.stroke(pointer)
  g.fill(new Path2D('M45 11.5 Q46 18 52.5 19 Q46 20 45 26.5 Q44 20 37.5 19 Q44 18 45 11.5 Z'))
  writeFileSync(`resources/trayTemplate${suffix}.png`, c.toBuffer('image/png'))
}
console.log('resources/trayTemplate.png, resources/trayTemplate@2x.png')
