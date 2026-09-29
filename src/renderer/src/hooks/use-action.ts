import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { errorMessage } from '@/lib/utils'

/** Wraps an async action with pending state and error/success toasts. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>, opts: { success?: string | ((r: R) => string); error?: string } = {}) {
  const [pending, setPending] = useState(false)
  const run = useCallback(
    async (...args: A): Promise<R | undefined> => {
      setPending(true)
      try {
        const r = await fn(...args)
        if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(r) : opts.success)
        return r
      } catch (e) {
        toast.error(opts.error ?? '操作失败', { description: errorMessage(e) })
        return undefined
      } finally {
        setPending(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fn],
  )
  return [run, pending] as const
}
