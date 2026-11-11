import type { TaskRunStatus } from '@shared/types'
import { t } from '@shared/i18n'

export function taskRunTimeline(status: TaskRunStatus, hasApproval: boolean): { label: string; done: boolean }[] {
  return [
    { label: t('已创建'), done: true },
    { label: t('已启动'), done: status !== 'queued' },
    ...(status === 'waiting_approval' || hasApproval ? [{ label: t('等待确认'), done: true }] : []),
    {
      label: status === 'error' ? t('失败') : status === 'cancelled' ? t('已取消') : status === 'skipped' ? t('已跳过') : t('完成'),
      done: ['success', 'error', 'cancelled', 'skipped'].includes(status),
    },
  ]
}
