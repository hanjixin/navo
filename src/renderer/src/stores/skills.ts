import { toast } from 'sonner'
import { call, on } from '@/lib/ipc'
import { errorMessage } from '@/lib/utils'
import { t } from '@shared/i18n'

let wired = false
/** Tells the user when a skill improved by itself (with a way back) or a suggestion is waiting. */
export function wireSkillEvents(): void {
  if (wired) return
  wired = true
  on('skills.evolved', (e) => {
    const failed = (err: unknown) => toast.error(t('撤销失败'), { description: errorMessage(err) })
    if (e.kind === 'patched') {
      toast(t('已改进 Skill「{{v0}}」', { v0: e.skill }), {
        description: e.summary,
        action:
          e.version && e.version > 1
            ? { label: t('撤销'), onClick: () => void call('skills.rollback', e.skill, e.version! - 1).then(() => toast.success(t('已撤销这次改进')), failed) }
            : undefined,
      })
    } else if (e.kind === 'created') {
      toast(t('已根据经验整理出 Skill「{{v0}}」', { v0: e.skill }), {
        description: e.summary,
        action: { label: t('撤销'), onClick: () => void call('skills.delete', e.skill).then(() => toast.success(t('已删除这个 Skill')), failed) },
      })
    } else {
      toast(t('有一条 Skill 改进建议'), {
        description: `${e.skill}：${e.summary}`,
        action: { label: t('查看'), onClick: () => (window.location.hash = '#/skills') },
      })
    }
  })
}
