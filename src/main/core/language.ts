import { app, BrowserWindow } from 'electron'
import { setLanguage, type Language } from '@shared/i18n'
import { getSettings } from './settings'

/** The language in effect: the setting, the system's (Chinese or not), or NAVO_LANG (tests). */
export function resolveLanguage(): Language {
  const forced = process.env.NAVO_LANG
  if (forced === 'zh' || forced === 'en') return forced
  const s = getSettings().language
  if (s === 'zh' || s === 'en') return s
  return /^zh/i.test(app.getPreferredSystemLanguages()[0] ?? app.getLocale()) ? 'zh' : 'en'
}

let applied: Language | null = null

/** Applies the language; when it changed, Navo's windows reload so everything is shown in it. */
export function applyLanguage(): Language {
  const lang = resolveLanguage()
  setLanguage(lang)
  if (applied && applied !== lang) for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.reload()
  applied = lang
  return lang
}
