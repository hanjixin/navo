/** A cancelled replay must never advance to another browser action. */
export function checkCancelled(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}

export function cancellable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  checkCancelled(signal)
  if (!signal) return work
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  checkCancelled(signal)
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(signal?.reason ?? new Error('Cancelled'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}
