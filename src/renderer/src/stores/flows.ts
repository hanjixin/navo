import { create } from 'zustand'
import { toast } from 'sonner'
import { on } from '@/lib/ipc'
import { t } from '@shared/i18n'

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
    toast(t('这件事以后还要做？'), {
      description: t('刚才的 {{v0}} 步浏览器操作可以固化成固定流程，下次直接回放，不再调用模型', { v0: actions }),
      duration: 12_000,
      action: { label: t('固化'), onClick: () => useFlowDialog.getState().open(threadId) },
    })
  })
  on('flows.repaired', ({ name, step, version }) => {
    toast(t('固定流程「{{v0}}」已自动修复', { v0: name }), {
      description: t('第 {{v0}} 步因页面变化失效，Agent 完成了剩下的操作并更新了流程（版本 {{v1}}）', { v0: step, v1: version }),
      action: { label: t('查看'), onClick: () => (window.location.hash = '#/macros') },
    })
  })
}
