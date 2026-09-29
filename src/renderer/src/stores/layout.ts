import { useEffect } from 'react'
import { create } from 'zustand'

/** Sidebar preference: null = automatic (collapse on narrow windows). */
type Pref = 'expanded' | 'collapsed' | null

export const SIDEBAR_EXPANDED = 208
export const SIDEBAR_COLLAPSED = 56
export const BROWSER_MIN = 360
export const BROWSER_DEFAULT = 560
/** Content area never gets narrower than this; the browser panel yields first. */
export const MAIN_MIN = 440
const AUTO_COLLAPSE_BELOW = 1240
const THREADS_AUTO_HIDE_BELOW = 680

function read<T>(k: string, d: T): T {
  try {
    const v = localStorage.getItem(k)
    return v == null ? d : (JSON.parse(v) as T)
  } catch {
    return d
  }
}
function write(k: string, v: unknown): void {
  try {
    localStorage.setItem(k, JSON.stringify(v))
  } catch {
    /* storage unavailable */
  }
}

interface LayoutState {
  windowWidth: number
  mainWidth: number
  sidebarPref: Pref
  threadsPref: boolean | null
  setWindowWidth: (w: number) => void
  setMainWidth: (w: number) => void
  toggleSidebar: () => void
  toggleThreads: () => void
}

export const useLayout = create<LayoutState>((set, get) => ({
  windowWidth: window.innerWidth,
  mainWidth: 800,
  sidebarPref: read<Pref>('layout.sidebar', null),
  threadsPref: read<boolean | null>('layout.threads', null),
  setWindowWidth: (windowWidth) => set({ windowWidth }),
  setMainWidth: (mainWidth) => set({ mainWidth }),
  toggleSidebar: () => {
    const next: Pref = sidebarCollapsed(get()) ? 'expanded' : 'collapsed'
    write('layout.sidebar', next)
    set({ sidebarPref: next })
  },
  toggleThreads: () => {
    const next = !threadsOpen(get())
    write('layout.threads', next)
    set({ threadsPref: next })
  },
}))

export const sidebarCollapsed = (s: Pick<LayoutState, 'sidebarPref' | 'windowWidth'>) =>
  s.sidebarPref ? s.sidebarPref === 'collapsed' : s.windowWidth < AUTO_COLLAPSE_BELOW

/** The thread list auto-hides when the chat column gets cramped, unless the user chose otherwise. */
export const threadsOpen = (s: Pick<LayoutState, 'threadsPref' | 'mainWidth'>) => s.threadsPref ?? s.mainWidth >= THREADS_AUTO_HIDE_BELOW

/** Largest browser width that still leaves MAIN_MIN for the content area. */
export function browserMax(windowWidth: number, collapsed: boolean): number {
  return Math.max(BROWSER_MIN, windowWidth - (collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED) - MAIN_MIN)
}

export function useWindowWidthTracker(): void {
  useEffect(() => {
    const fn = () => useLayout.getState().setWindowWidth(window.innerWidth)
    window.addEventListener('resize', fn)
    return () => window.removeEventListener('resize', fn)
  }, [])
}
