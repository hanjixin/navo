import { toast } from 'sonner'
import { call, on } from '@/lib/ipc'
import { errorMessage } from '@/lib/utils'

let wired = false
/** Tells the user when a skill improved by itself (with a way back) or a suggestion is waiting. */
export function wireSkillEvents(): void {
  if (wired) return
  wired = true
  on('skills.evolved', (e) => {
    const failed = (err: unknown) => toast.error('撤销失败', { description: errorMessage(err) })
    if (e.kind === 'patched') {
      toast(`已改进 Skill「${e.skill}」`, {
        description: e.summary,
        action:
          e.version && e.version > 1
            ? { label: '撤销', onClick: () => void call('skills.rollback', e.skill, e.version! - 1).then(() => toast.success('已撤销这次改进'), failed) }
            : undefined,
      })
    } else if (e.kind === 'created') {
      toast(`已根据经验整理出 Skill「${e.skill}」`, {
        description: e.summary,
        action: { label: '撤销', onClick: () => void call('skills.delete', e.skill).then(() => toast.success('已删除这个 Skill'), failed) },
      })
    } else {
      toast('有一条 Skill 改进建议', {
        description: `${e.skill}：${e.summary}`,
        action: { label: '查看', onClick: () => (window.location.hash = '#/skills') },
      })
    }
  })
}
