import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { z } from 'zod'
import type { BuiltinConnector } from '@shared/types'
import { checkWebhook, sendBot, type BotKind, type BotMessage } from './bots'
import { createEvent, listEvents, verifyCalDav, type CalDavConfig } from './caldav'
import { listEmail, readEmail, sendEmail, verifyEmail, type EmailConfig } from './email'
import { t, tk } from '@shared/i18n'

/** Tools that send something on the user's behalf: they pause for approval like other outward actions. */
export const BUILTIN_SEND_TOOLS = ['wecom_send_message', 'dingtalk_bot_send_message', 'feishu_bot_send_message', 'email_send', 'calendar_create_event']

const BOT_NAME: Record<BotKind, { prefix: string; label: string }> = {
  'wecom-bot': { prefix: 'wecom', label: tk('企业微信群') },
  'dingtalk-bot': { prefix: 'dingtalk_bot', label: tk('钉钉群') },
  'feishu-bot': { prefix: 'feishu_bot', label: tk('飞书群') },
}

type Values = Record<string, string>
const bot = (v: Values) => ({ webhook: v.webhook, secret: v.secret || undefined })

/** Checks the values work (logs in, or checks the address) before the connector counts as connected. */
export async function verifyBuiltin(kind: BuiltinConnector, v: Values): Promise<void> {
  if (kind === 'email') return verifyEmail(v as unknown as EmailConfig)
  if (kind === 'caldav') return verifyCalDav(v as unknown as CalDavConfig)
  // e2e tests point bots at a local server
  checkWebhook(kind, v.webhook ?? '', !!process.env.AB_ALLOW_ANY_WEBHOOK)
}

/** Sends an alert (a monitor's, or a test message): to the group, or by email to yourself. */
export async function notifyBuiltin(kind: BuiltinConnector, v: Values, msg: BotMessage): Promise<void> {
  if (kind === 'email') {
    await sendEmail(v as unknown as EmailConfig, { to: v.address, subject: msg.title || tk('Navo 提醒'), body: msg.text })
    return
  }
  if (kind === 'caldav') throw new Error(t('日历不能接收消息'))
  await sendBot(kind, bot(v), msg)
}

export function builtinTools(kind: BuiltinConnector, v: Values, label: string): StructuredToolInterface[] {
  const defineTool = <S extends z.ZodObject>(name: string, description: string, schema: S, fn: (a: z.infer<S>) => Promise<string>) =>
    tool(async (a) => fn(a as z.infer<S>), { name, description, schema }) as unknown as StructuredToolInterface
  if (kind === 'email') {
    const c = v as unknown as EmailConfig
    return [
      defineTool(
        'email_list',
        `列出邮箱 ${c.address} 的最新邮件（可只看未读、按关键词 / 发件人 / 日期筛选）。每行带 uid，用 email_read 读正文。`,
        z.object({
          folder: z.string().optional().describe('文件夹，默认 INBOX'),
          limit: z.number().int().optional().describe('最多几封，默认 20'),
          unreadOnly: z.boolean().optional(),
          query: z.string().optional().describe('主题或发件人里的关键词'),
          from: z.string().optional().describe('发件人地址或名字'),
          since: z.string().optional().describe('从哪天起，YYYY-MM-DD'),
        }),
        (a) => listEmail(c, a),
      ),
      defineTool('email_read', '读一封邮件的正文和附件名。', z.object({ uid: z.number().int(), folder: z.string().optional() }), (a) =>
        readEmail(c, a.uid, a.folder),
      ),
      defineTool(
        'email_send',
        `用 ${c.address} 发送邮件（正文用 Markdown，会转成格式化邮件）。发送前会请用户确认。`,
        z.object({
          to: z.string().describe('收件人，多个用逗号分隔'),
          subject: z.string(),
          body: z.string().describe('正文，Markdown'),
          cc: z.string().optional(),
        }),
        (a) => sendEmail(c, a),
      ),
    ]
  }
  if (kind === 'caldav') {
    const c = v as unknown as CalDavConfig
    return [
      defineTool(
        'calendar_list_events',
        '查看日历里一段时间的日程。时间用 2026-10-15 或 2026-10-15T09:00（本地时间）。',
        z.object({ from: z.string(), to: z.string(), calendar: z.string().optional().describe('日历名称，默认全部') }),
        (a) => listEvents(c, a),
      ),
      defineTool(
        'calendar_create_event',
        '在日历里创建日程（不写结束时间则为 1 小时）。创建前会请用户确认。',
        z.object({
          summary: z.string().describe('标题'),
          start: z.string().describe('开始，如 2026-10-16T14:00'),
          end: z.string().optional(),
          location: z.string().optional(),
          description: z.string().optional(),
          calendar: z.string().optional().describe('日历名称，默认第一个'),
        }),
        (a) => createEvent(c, a),
      ),
    ]
  }
  const b = BOT_NAME[kind]
  return [
    defineTool(
      `${b.prefix}_send_message`,
      `通过群机器人往${label || t(b.label)}发一条消息（Markdown）。适合通知、日报、提醒。发送前会请用户确认。`,
      z.object({ title: z.string().optional(), text: z.string().describe('消息内容，Markdown') }),
      async (a) => {
        await sendBot(kind, bot(v), a)
        return `已发送到${label || t(b.label)}`
      },
    ),
  ]
}
