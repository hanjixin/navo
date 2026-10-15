/** Just enough iCalendar (RFC 5545) for listing and creating events over CalDAV. */

export interface CalEvent {
  uid: string
  summary: string
  start: Date
  end?: Date
  allDay: boolean
  location?: string
  description?: string
  recurring: boolean
}

/** Lines folded with CRLF + space/tab are one line. */
const unfold = (ics: string) => ics.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)

const unescapeText = (s: string) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1')
const escapeText = (s: string) =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/([,;])/g, '\\$1')

/** 20261015T090000Z (UTC), 20261015T090000 with or without TZID (taken as local time), 20261015 (all day) */
export function parseIcsDate(value: string): { date: Date; allDay: boolean } {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim())
  if (!m) return { date: new Date(value), allDay: false }
  const [, y, mo, d, h, mi, s, z] = m
  if (h === undefined) return { date: new Date(+y, +mo - 1, +d), allDay: true }
  return { date: z ? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)) : new Date(+y, +mo - 1, +d, +h, +mi, +s), allDay: false }
}

export function parseEvents(ics: string): CalEvent[] {
  const out: CalEvent[] = []
  let cur: Partial<CalEvent> | null = null
  for (const raw of unfold(ics)) {
    if (raw === 'BEGIN:VEVENT') cur = { recurring: false, allDay: false }
    else if (raw === 'END:VEVENT' && cur) {
      if (cur.start) out.push({ uid: cur.uid ?? '', summary: cur.summary ?? '（无标题）', ...cur } as CalEvent)
      cur = null
    } else if (cur) {
      const i = raw.indexOf(':')
      if (i < 0) continue
      const name = raw.slice(0, i).split(';')[0].toUpperCase()
      const value = raw.slice(i + 1)
      if (name === 'UID') cur.uid = value
      else if (name === 'SUMMARY') cur.summary = unescapeText(value)
      else if (name === 'LOCATION') cur.location = unescapeText(value)
      else if (name === 'DESCRIPTION') cur.description = unescapeText(value)
      else if (name === 'RRULE') cur.recurring = true
      else if (name === 'DTSTART') {
        const d = parseIcsDate(value)
        cur.start = d.date
        cur.allDay = d.allDay
      } else if (name === 'DTEND') cur.end = parseIcsDate(value).date
    }
  }
  return out
}

const utc = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')

export function buildEvent(e: { uid: string; summary: string; start: Date; end: Date; location?: string; description?: string }, now = new Date()): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Navo//CalDAV//ZH',
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `DTSTAMP:${utc(now)}`,
    `DTSTART:${utc(e.start)}`,
    `DTEND:${utc(e.end)}`,
    `SUMMARY:${escapeText(e.summary)}`,
    ...(e.location ? [`LOCATION:${escapeText(e.location)}`] : []),
    ...(e.description ? [`DESCRIPTION:${escapeText(e.description)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n')
}

const p2 = (n: number) => String(n).padStart(2, '0')
export const fmtLocal = (d: Date, allDay = false) =>
  `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}${allDay ? '' : ` ${p2(d.getHours())}:${p2(d.getMinutes())}`}`

export function describeEvent(e: CalEvent): string {
  const when = e.allDay
    ? `${fmtLocal(e.start, true)}（全天）`
    : `${fmtLocal(e.start)}${e.end ? ` – ${fmtLocal(e.end).slice(e.end.toDateString() === e.start.toDateString() ? 11 : 0)}` : ''}`
  return `- ${when} ${e.summary}${e.location ? ` @ ${e.location}` : ''}${e.recurring ? '（重复）' : ''}`
}
