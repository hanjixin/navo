import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { botError, botRequest, checkWebhook } from '../src/main/connectors/builtin/bots'
import { serversOf } from '../src/main/connectors/builtin/email'
import { buildEvent, describeEvent, parseEvents, parseIcsDate } from '../src/main/connectors/builtin/ical'
import { isWriteTool } from '../src/main/connectors/write-tools'

const NOW = 1_792_000_000_000

describe('group bots', () => {
  it('checks webhook addresses', () => {
    expect(() => checkWebhook('wecom-bot', 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc-123')).not.toThrow()
    expect(() => checkWebhook('dingtalk-bot', 'https://oapi.dingtalk.com/robot/send?access_token=ff00')).not.toThrow()
    expect(() => checkWebhook('feishu-bot', 'https://open.feishu.cn/open-apis/bot/v2/hook/xx-yy')).not.toThrow()
    expect(() => checkWebhook('wecom-bot', 'https://example.com/hook')).toThrow('Webhook 地址不对')
    expect(() => checkWebhook('wecom-bot', 'http://127.0.0.1:9/hook', true)).not.toThrow()
  })

  it('WeCom: markdown with the title in bold, clipped to 4096 bytes', () => {
    const r = botRequest('wecom-bot', { webhook: 'W' }, { title: '日报', text: '完成 **3** 项' })
    expect(r).toEqual({ url: 'W', body: { msgtype: 'markdown', markdown: { content: '**日报**\n完成 **3** 项' } } })
    const long = botRequest('wecom-bot', { webhook: 'W' }, { text: '汉'.repeat(3000) }).body as { markdown: { content: string } }
    expect(Buffer.byteLength(long.markdown.content)).toBeLessThanOrEqual(4096)
    expect(long.markdown.content).toContain('已截断')
  })

  it('DingTalk: 加签 = base64(HmacSHA256(secret, "timestamp\\nsecret")) in the URL', () => {
    const r = botRequest(
      'dingtalk-bot',
      { webhook: 'https://oapi.dingtalk.com/robot/send?access_token=t', secret: 'SECabc' },
      { title: '提醒', text: '内容' },
      NOW,
    )
    const sign = createHmac('sha256', 'SECabc').update(`${NOW}\nSECabc`).digest('base64')
    expect(r.url).toBe(`https://oapi.dingtalk.com/robot/send?access_token=t&timestamp=${NOW}&sign=${encodeURIComponent(sign)}`)
    expect(r.body).toEqual({ msgtype: 'markdown', markdown: { title: '提醒', text: '### 提醒\n内容' } })
    expect(botRequest('dingtalk-bot', { webhook: 'U' }, { text: 'x' }, NOW).url).toBe('U')
  })

  it('Feishu: a markdown card; 签名 = base64(HmacSHA256(key "timestamp\\nsecret", ""))', () => {
    const r = botRequest('feishu-bot', { webhook: 'F', secret: 's3' }, { title: '标题', text: '**粗**' }, NOW).body as Record<string, unknown>
    const ts = Math.floor(NOW / 1000)
    expect(r.timestamp).toBe(String(ts))
    expect(r.sign).toBe(createHmac('sha256', `${ts}\ns3`).update('').digest('base64'))
    expect(r.msg_type).toBe('interactive')
    expect(r.card).toEqual({ header: { title: { tag: 'plain_text', content: '标题' } }, elements: [{ tag: 'markdown', content: '**粗**' }] })
  })

  it('reads the error codes in 200 responses, with hints', () => {
    expect(botError('wecom-bot', { errcode: 0, errmsg: 'ok' })).toBeNull()
    expect(botError('feishu-bot', { code: 0 })).toBeNull()
    expect(botError('dingtalk-bot', { errcode: 310000, errmsg: 'sign not match' })).toMatch(/310000.*加签/)
    expect(botError('feishu-bot', { code: 19021, msg: 'sign match fail' })).toMatch(/19021.*签名/)
  })
})

describe('email servers', () => {
  it('presets for Chinese providers, or your own servers', () => {
    expect(serversOf({ provider: 'qq', address: 'a@qq.com', password: 'x' })).toEqual({
      imap: { host: 'imap.qq.com', port: 993 },
      smtp: { host: 'smtp.qq.com', port: 465 },
    })
    expect(serversOf({ provider: '163', address: 'a@163.com', password: 'x' }).imap.host).toBe('imap.163.com')
    expect(serversOf({ provider: 'custom', address: 'a@b.c', password: 'x', imap_host: 'i.b.c', smtp_host: 's.b.c', smtp_port: '587' })).toEqual({
      imap: { host: 'i.b.c', port: 993 },
      smtp: { host: 's.b.c', port: 587 },
    })
    expect(() => serversOf({ provider: 'custom', address: 'a@b.c', password: 'x' })).toThrow('IMAP')
  })
})

describe('iCalendar', () => {
  it('dates: UTC, local (with TZID), all day', () => {
    expect(parseIcsDate('20261015T090000Z').date.toISOString()).toBe('2026-10-15T09:00:00.000Z')
    expect(parseIcsDate('20261015T090000').date.getHours()).toBe(9)
    expect(parseIcsDate('20261015')).toEqual({ date: new Date(2026, 9, 15), allDay: true })
  })

  it('round trip: what Navo creates reads back the same (escaping, folding)', () => {
    const start = new Date('2026-10-16T06:00:00Z')
    const ics = buildEvent({
      uid: 'u1',
      summary: '评审, 第二轮; 带\\反斜杠',
      start,
      end: new Date('2026-10-16T07:00:00Z'),
      location: '3 楼',
      description: '第一行\n第二行',
    })
    expect(ics).toContain('SUMMARY:评审\\, 第二轮\\; 带\\\\反斜杠')
    const folded = ics.replace('DESCRIPTION:第一行', 'DESCRIPTION:第一\r\n 行')
    const [e] = parseEvents(folded)
    expect(e).toMatchObject({
      uid: 'u1',
      summary: '评审, 第二轮; 带\\反斜杠',
      location: '3 楼',
      description: '第一行\n第二行',
      allDay: false,
      recurring: false,
    })
    expect(e.start.toISOString()).toBe(start.toISOString())
  })

  it('recurring and all-day events are described', () => {
    const [e] = parseEvents('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nSUMMARY:周会\nDTSTART;VALUE=DATE:20261019\nRRULE:FREQ=WEEKLY\nEND:VEVENT\nEND:VCALENDAR')
    expect(describeEvent(e)).toBe('- 2026-10-19（全天） 周会（重复）')
  })
})

describe('office MCP tools that need approval', () => {
  it('writes (send, create, delete…) do; reads do not', () => {
    const writes = [
      'mcp__feishu__im_v1_message_create',
      'mcp__feishu__bitable_v1_appTableRecord_update',
      'mcp__feishu__drive_v1_permissionMember_create',
      'mcp__dingtalk__sendMessageToGroupByRobot',
      'mcp__dingtalk__deleteEvent',
      'mcp__dingtalk__addAttendee',
    ]
    const reads = [
      'mcp__feishu__im_v1_message_list',
      'mcp__feishu__docx_v1_document_rawContent',
      'mcp__feishu__wiki_v1_node_search',
      'mcp__dingtalk__getCalendarView',
      'mcp__dingtalk__searchUser',
      'mcp__dingtalk__currentDateTime',
    ]
    expect(writes.filter((n) => !isWriteTool(n))).toEqual([])
    expect(reads.filter(isWriteTool)).toEqual([])
  })
})
