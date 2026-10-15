import { randomUUID } from 'node:crypto'
import { createDAVClient, type DAVCalendar } from 'tsdav'
import { buildEvent, describeEvent, parseEvents, type CalEvent } from './ical'

/**
 * A calendar over CalDAV: iCloud, Feishu / DingTalk calendars (they offer CalDAV accounts in their
 * calendar settings), Nextcloud, Radicale and others.
 */

export interface CalDavConfig {
  server: string
  username: string
  password: string
}

export const CALDAV_SERVERS: Record<string, string> = {
  icloud: 'https://caldav.icloud.com',
}

async function client(c: CalDavConfig) {
  const serverUrl = CALDAV_SERVERS[c.server] ?? c.server
  if (!/^https?:\/\//.test(serverUrl)) throw new Error('请填写 CalDAV 服务器地址')
  try {
    return await createDAVClient({ serverUrl, credentials: { username: c.username, password: c.password }, authMethod: 'Basic', defaultAccountType: 'caldav' })
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    throw new Error(/401|unauthor/i.test(m) ? `登录失败，请检查用户名和密码（${m}）` : `连不上 CalDAV 服务器（${m}）`, { cause: err })
  }
}

/** calendars that hold events (not task lists) */
const eventCalendars = (cals: DAVCalendar[]) => cals.filter((c) => !c.components || c.components.includes('VEVENT'))
const nameOf = (c: DAVCalendar) => (typeof c.displayName === 'string' ? c.displayName : '') || c.url.split('/').filter(Boolean).pop() || '日历'

export async function verifyCalDav(c: CalDavConfig): Promise<void> {
  const dav = await client(c)
  const cals = eventCalendars(await dav.fetchCalendars())
  if (!cals.length) throw new Error('这个账号下没有日历')
}

function pick(cals: DAVCalendar[], name?: string): DAVCalendar[] {
  if (!name) return cals
  const hit = cals.filter((c) => nameOf(c) === name)
  if (!hit.length) throw new Error(`没有名为「${name}」的日历，可用的有：${cals.map(nameOf).join('、')}`)
  return hit
}

export async function listEvents(c: CalDavConfig, o: { from: string; to: string; calendar?: string }): Promise<string> {
  const start = new Date(o.from)
  const end = new Date(o.to)
  if (Number.isNaN(+start) || Number.isNaN(+end)) throw new Error('时间格式不对，用 2026-10-15 或 2026-10-15T09:00')
  const dav = await client(c)
  const cals = pick(eventCalendars(await dav.fetchCalendars()), o.calendar)
  const events: (CalEvent & { cal: string })[] = []
  for (const cal of cals) {
    const objs = await dav.fetchCalendarObjects({ calendar: cal, timeRange: { start: start.toISOString(), end: end.toISOString() } })
    for (const obj of objs) for (const e of parseEvents(String(obj.data ?? ''))) events.push({ ...e, cal: nameOf(cal) })
  }
  events.sort((a, b) => +a.start - +b.start)
  const head = `${cals.map(nameOf).join('、')}：${events.length} 个日程`
  return events.length
    ? `${head}\n${events.map((e) => `${describeEvent(e)}${cals.length > 1 ? `〔${e.cal}〕` : ''}`).join('\n')}`
    : `${head}（这段时间没有安排）`
}

export async function createEvent(
  c: CalDavConfig,
  o: { summary: string; start: string; end?: string; location?: string; description?: string; calendar?: string },
): Promise<string> {
  const start = new Date(o.start)
  const end = o.end ? new Date(o.end) : new Date(+start + 60 * 60_000)
  if (Number.isNaN(+start) || Number.isNaN(+end) || end <= start) throw new Error('开始 / 结束时间不对')
  const dav = await client(c)
  const [cal] = pick(eventCalendars(await dav.fetchCalendars()), o.calendar)
  const uid = `${randomUUID()}@navo`
  const res = await dav.createCalendarObject({
    calendar: cal,
    filename: `${uid}.ics`,
    iCalString: buildEvent({ uid, summary: o.summary, start, end, location: o.location, description: o.description }),
  })
  if (!res.ok) throw new Error(`创建失败：HTTP ${res.status}`)
  return `已在「${nameOf(cal)}」创建日程：${describeEvent({ uid, summary: o.summary, start, end, allDay: false, location: o.location, recurring: false }).slice(2)}`
}
