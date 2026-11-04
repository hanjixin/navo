import { useEffect } from 'react'
import { on } from '@/lib/ipc'

/** A burst of writes or window activation causes one refresh. */
export function useProjectFileRefresh(refresh: () => void) {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      clearTimeout(timer)
      timer = setTimeout(refresh, 180)
    }
    const visible = () => {
      if (document.visibilityState === 'visible') schedule()
    }
    const off = on('outputs.changed', schedule)
    window.addEventListener('focus', schedule)
    document.addEventListener('visibilitychange', visible)
    return () => {
      clearTimeout(timer)
      off()
      window.removeEventListener('focus', schedule)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [refresh])
}
