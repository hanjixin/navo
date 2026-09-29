import { useEffect, useState } from 'react'
import { useSettings } from '@/stores/settings'

/** Resolves the effective theme and toggles the `dark` class on <html>. */
export function useTheme(): 'light' | 'dark' {
  const pref = useSettings((s) => s.settings?.theme ?? 'system')
  const [system, setSystem] = useState(() => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const fn = () => setSystem(mq.matches ? 'dark' : 'light')
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  }, [])
  const theme = pref === 'system' ? system : pref
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])
  return theme as 'light' | 'dark'
}
