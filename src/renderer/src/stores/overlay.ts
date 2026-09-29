import { useEffect } from 'react'
import { create } from 'zustand'

/**
 * The embedded browser is a native view drawn above the DOM. While any floating layer
 * (dialog, menu, select) is open we hide it so the layer isn't covered.
 */
interface OverlayState {
  count: number
  inc: () => void
  dec: () => void
}

export const useOverlayStore = create<OverlayState>((set) => ({
  count: 0,
  inc: () => set((s) => ({ count: s.count + 1 })),
  dec: () => set((s) => ({ count: Math.max(0, s.count - 1) })),
}))

export function useOverlay(active = true): void {
  useEffect(() => {
    if (!active) return
    useOverlayStore.getState().inc()
    return () => useOverlayStore.getState().dec()
  }, [active])
}
