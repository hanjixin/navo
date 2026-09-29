import { create } from 'zustand'
import type { BrowserState } from '@shared/types'
import { toast } from 'sonner'
import { call, on } from '@/lib/ipc'

interface BrowserStore {
  state: BrowserState
  open: boolean
  width: number
  recordingSteps: number
  lastRecorded?: string
  /** floating mini window while the panel is collapsed */
  mini: boolean
  preview: { tabId: number; image: string } | null
  setMini: (v: boolean) => void
  setOpen: (v: boolean) => void
  setWidth: (w: number) => void
}

const stored = (k: string, d: number) => {
  try {
    const v = Number(localStorage.getItem(k))
    return Number.isFinite(v) && v > 0 ? v : d
  } catch {
    return d
  }
}

export const useBrowser = create<BrowserStore>((set) => ({
  state: { tabs: [], agentControlled: false, recording: false },
  open: (() => {
    try {
      return localStorage.getItem('browser.open') !== '0'
    } catch {
      return true
    }
  })(),
  width: stored('browser.width', 560),
  recordingSteps: 0,
  mini: false,
  preview: null,
  setMini: (mini) => set({ mini }),
  setOpen: (open) => {
    try {
      localStorage.setItem('browser.open', open ? '1' : '0')
    } catch {
      /* ignore */
    }
    // collapsing while the agent works keeps it visible in the mini window
    set((st) => (open ? { open, mini: false } : { open, mini: st.state.agentControlled || st.mini }))
  },
  setWidth: (width) => {
    try {
      localStorage.setItem('browser.width', String(width))
    } catch {
      /* ignore */
    }
    set({ width })
  },
}))

let wired = false
export function wireBrowserEvents(): void {
  if (wired) return
  wired = true
  void call('browser.state').then((state) => useBrowser.setState({ state }))
  on('browser.state', (state) => useBrowser.setState({ state }))
  on('browser.download', (d) => {
    if (d.state === 'completed') {
      toast.success(`已下载 ${d.filename}`, { action: { label: '在文件夹中显示', onClick: () => void call('app.showItem', d.path) } })
    } else if (d.state === 'progressing') {
      toast(`正在下载 ${d.filename}`, { description: '完成后会保存到「下载」文件夹' })
    } else toast.error(`下载失败：${d.filename}`)
  })
  // the agent is using the browser: an open panel shows it; a collapsed one gets the mini window
  on('browser.reveal', ({ open }) => {
    const s = useBrowser.getState()
    if (s.open) return
    if (open) s.setOpen(true)
    else useBrowser.setState({ mini: true })
  })
  on('browser.preview', (preview) => useBrowser.setState({ preview }))
  on('macros.recording', ({ steps, last }) => useBrowser.setState({ recordingSteps: steps, lastRecorded: last }))
}
