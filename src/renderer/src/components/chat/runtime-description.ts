import type { AgentRuntimeCapabilities } from '@shared/agent-runtime'
import { t } from '@shared/i18n'

/** Model ownership and tool availability are independent runtime capabilities. */
export function runtimeConversationDescription(capabilities?: AgentRuntimeCapabilities): string {
  if (!capabilities) return t('正在加载运行时能力…')
  if (capabilities.navoTools && capabilities.approvals) return t('使用本机模型配置，通过 Navo 工具完成任务；需要确认时会暂停。')
  if (capabilities.navoTools) return t('使用本机模型配置，通过 Navo 工具完成任务。')
  return t('外部运行时使用本机配置，暂不支持 Navo 工具、审批和图片输入。')
}
