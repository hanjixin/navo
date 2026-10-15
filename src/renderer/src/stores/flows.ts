import { create } from 'zustand'
import { toast } from 'sonner'
import { on } from '@/lib/ipc'

/** Which conversation the "keep as a fixed flow" dialog is open for. */
export const useFlowDialog = create<{ threadId: string | null; open: (threadId: string) => void; close: () => void }>((set) => ({
  threadId: null,
  open: (threadId) => set({ threadId }),
  close: () => set({ threadId: null }),
}))

let wired = false
export function wireFlowEvents(): void {
  if (wired) return
  wired = true
  // a browser task that sounds recurring: offer to keep it
  on('flows.suggest', ({ threadId, actions }) => {
    toast('这件事以后还要做？', {
      description: `刚才的 ${actions} 步浏览器操作可以固化成固定流程，下次直接回放，不再调用模型`,
      duration: 12_000,
      action: { label: '固化', onClick: () => useFlowDialog.getState().open(threadId) },
    })
  })
  on('flows.repaired', ({ name, step, version }) => {
    toast(`固定流程「${name}」已自动修复`, {
      description: `第 ${step} 步因页面变化失效，Agent 完成了剩下的操作并更新了流程（版本 ${version}）`,
      action: { label: '查看', onClick: () => (window.location.hash = '#/macros') },
    })
  })
}
