import { createHmac } from 'node:crypto'
import { t } from '@shared/i18n'

/**
 * Group bots of WeCom (企业微信), DingTalk (钉钉) and Feishu (飞书): a webhook address the group
 * admin copies from the bot's settings, optionally with a signing secret (钉钉 / 飞书「加签」).
 */

export type BotKind = 'wecom-bot' | 'dingtalk-bot' | 'feishu-bot'

export interface BotMessage {
  title?: string
  /** Markdown */
  text: string
}

const HOSTS: Record<BotKind, RegExp> = {
  'wecom-bot': /^https:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=[\w-]+/,
  'dingtalk-bot': /^https:\/\/oapi\.dingtalk\.com\/robot\/send\?access_token=\w+/,
  'feishu-bot': /^https:\/\/open\.(feishu\.cn|larksuite\.com)\/open-apis\/bot\/v2\/hook\/[\w-]+/,
}

/** Checks a webhook address (any http(s) address is accepted when `allowAny`, for tests and private deployments). */
export function checkWebhook(kind: BotKind, url: string, allowAny = false): void {
  if (HOSTS[kind].test(url.trim())) return
  if (allowAny && /^https?:\/\/\S+$/.test(url.trim())) return
  const example = {
    'wecom-bot': 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…',
    'dingtalk-bot': 'https://oapi.dingtalk.com/robot/send?access_token=…',
    'feishu-bot': 'https://open.feishu.cn/open-apis/bot/v2/hook/…',
  }[kind]
  throw new Error(t('Webhook 地址不对，应该像 {{v0}}', { v0: example }))
}

/** WeCom's markdown takes at most 4096 bytes; DingTalk and Feishu are roomier, but a group message should be short */
function clipBytes(s: string, max: number): string {
  const buf = Buffer.from(s)
  if (buf.length <= max) return s
  return `${buf
    .subarray(0, max - 20)
    .toString('utf8')
    .replace(/�+$/, '')}\n…（已截断）`
}

/** The HTTP request a bot message becomes. `now` is injectable for tests. */
export function botRequest(kind: BotKind, cfg: { webhook: string; secret?: string }, msg: BotMessage, now = Date.now()): { url: string; body: unknown } {
  const title = msg.title?.trim()
  switch (kind) {
    case 'wecom-bot':
      return { url: cfg.webhook, body: { msgtype: 'markdown', markdown: { content: clipBytes(title ? `**${title}**\n${msg.text}` : msg.text, 4096) } } }
    case 'dingtalk-bot': {
      let url = cfg.webhook
      if (cfg.secret) {
        // 加签: HmacSHA256(key = secret, "timestamp\nsecret"), base64, URL-encoded
        const sign = createHmac('sha256', cfg.secret).update(`${now}\n${cfg.secret}`).digest('base64')
        url += `&timestamp=${now}&sign=${encodeURIComponent(sign)}`
      }
      return {
        url,
        body: {
          msgtype: 'markdown',
          markdown: { title: title || msg.text.slice(0, 20), text: clipBytes(title ? `### ${title}\n${msg.text}` : msg.text, 16000) },
        },
      }
    }
    case 'feishu-bot': {
      const ts = Math.floor(now / 1000)
      // 签名校验: HmacSHA256(key = "timestamp\nsecret", empty message), base64
      const signed = cfg.secret ? { timestamp: String(ts), sign: createHmac('sha256', `${ts}\n${cfg.secret}`).update('').digest('base64') } : {}
      return {
        url: cfg.webhook,
        body: {
          ...signed,
          msg_type: 'interactive',
          card: {
            ...(title ? { header: { title: { tag: 'plain_text', content: title } } } : {}),
            elements: [{ tag: 'markdown', content: clipBytes(msg.text, 16000) }],
          },
        },
      }
    }
  }
}

/** The platforms answer 200 with an error code in the body. */
export function botError(kind: BotKind, res: Record<string, unknown>): string | null {
  const code = kind === 'feishu-bot' ? (res.code ?? res.StatusCode) : res.errcode
  if (code === 0 || code === undefined) return null
  const msg = (kind === 'feishu-bot' ? res.msg : res.errmsg) as string | undefined
  const hint =
    kind === 'dingtalk-bot' && /sign|keywords/i.test(msg ?? '')
      ? '（检查「加签」密钥，或机器人设置了关键词时消息里要包含关键词）'
      : kind === 'feishu-bot' && /sign/i.test(msg ?? '')
        ? '（检查签名校验的密钥）'
        : ''
  return `${msg ?? '发送失败'}（错误码 ${code}）${hint}`
}

export async function sendBot(kind: BotKind, cfg: { webhook: string; secret?: string }, msg: BotMessage): Promise<void> {
  const { url, body } = botRequest(kind, cfg, msg)
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(t('发送失败：HTTP {{v0}}', { v0: res.status }))
  const err = botError(kind, (await res.json().catch(() => ({}))) as Record<string, unknown>)
  if (err) throw new Error(err)
}
