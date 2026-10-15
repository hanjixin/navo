import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { t } from '@shared/i18n'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return t('刚刚')
  if (s < 3600) return t('{{v0}} 分钟前', { v0: Math.floor(s / 60) })
  if (s < 86400) return t('{{v0}} 小时前', { v0: Math.floor(s / 3600) })
  if (s < 86400 * 7) return t('{{v0}} 天前', { v0: Math.floor(s / 86400) })
  return new Date(ts).toLocaleDateString('zh-CN')
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function errorMessage(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err)
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
