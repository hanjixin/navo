import { t } from './i18n'

export const SYSTEM_AGENT_ID = 'navo-assistant'

export function agentTemplateTeams() {
  return [
    { id: 'engineering', name: t('研发团队') },
    { id: 'project', name: t('项目协作团队') },
  ] as const
}

export type AgentTemplateTeamId = ReturnType<typeof agentTemplateTeams>[number]['id']

export function systemAgentDefaults() {
  return {
    name: t('Navo 助手'),
    description: t('查资料、整理文件，把日常任务交给我。'),
    instructions: t('根据用户的目标选择可用工具，完成任务后给出结果和相关文件或来源。'),
  }
}

export function agentTemplates() {
  return [
    {
      id: 'tech-brief',
      team: 'engineering',
      name: t('技术简报助手'),
      description: t('按主题阅读技术资讯，生成附原文链接的简报。'),
      instructions: t('按用户给出的主题和时间范围筛选文章，优先阅读原文。每条列出发布日期、核心发现和来源链接，合并重复报道。'),
      connectors: [],
      plugins: ['hacker-news'],
    },
    {
      id: 'engineering-update',
      team: 'engineering',
      name: t('研发周报助手'),
      description: t('从 PR 和任务记录提取进展、阻塞与下周计划。'),
      instructions: t('先确定项目和统计周期。从可用的 PR、任务记录或用户提供的材料中区分已完成与进行中的工作。按进展、阻塞、下一步整理周报，附记录链接。'),
      connectors: ['github', 'linear'],
      plugins: [],
    },
    {
      id: 'meeting-prep',
      team: 'project',
      name: t('会前准备助手'),
      description: t('结合日程和邮件，整理会议议程与待决问题。'),
      instructions: t('根据用户指定的会议，从日程、相关邮件或用户提供的材料中整理会议目标、议题、待决问题和准备清单。标出缺少的信息，先交付给用户审阅。'),
      connectors: ['caldav', 'email'],
      plugins: [],
    },
  ] as const
}

export type AgentTemplateId = ReturnType<typeof agentTemplates>[number]['id']
