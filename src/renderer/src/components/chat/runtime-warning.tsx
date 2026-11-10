import { AlertTriangle } from 'lucide-react'
import type { UIMessage } from '@shared/types'
import { t } from '@shared/i18n'

export function RuntimeWarning({ warning }: { warning: NonNullable<UIMessage['runtimeWarning']> }) {
  const message =
    warning === 'unexecuted_tool_markup'
      ? t('模型返回了未识别的工具调用格式，这些操作没有执行。请检查模型或网关的工具调用兼容性。')
      : warning === 'tool_outcome_unknown'
        ? t('连接中断时工具可能已经执行，结果尚未确认。为避免重复操作，系统不会自动重试。')
        : t('运行时连接已中断，待确认的操作不会自动执行。请重新发送消息以继续。')
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-warning/25 bg-warning/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground"
    >
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warning" />
      <span>{message}</span>
    </div>
  )
}
