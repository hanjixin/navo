import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from '@/lib/utils'

export interface AsyncState<T> {
  data: T | undefined
  loading: boolean
  error: string | null
  reload: () => void
  setData: (d: T | ((prev: T | undefined) => T)) => void
}

/** Loads data with explicit loading / error state; keeps stale data visible on refresh errors. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)
  const fnRef = useRef(fn)
  fnRef.current = fn

  const reload = useCallback(() => {
    const id = ++seq.current
    setLoading(true)
    fnRef.current().then(
      (d) => {
        if (id !== seq.current) return
        setData(d)
        setError(null)
        setLoading(false)
      },
      (e) => {
        if (id !== seq.current) return
        setError(errorMessage(e))
        setLoading(false)
      },
    )
  }, [])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, deps)

  return { data, loading, error, reload, setData: setData as AsyncState<T>['setData'] }
}
