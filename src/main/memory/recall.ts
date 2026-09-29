import type { Memory, MemoryKind } from '@shared/types'

/**
 * Pure memory logic: tokenising, relevance ranking, dedupe and the secret filter.
 * Memories number in the hundreds to low thousands, so ranking in memory beats a search index:
 * character bigrams make two-character Chinese words ("西湖", "报销") match, which SQLite's
 * trigram FTS cannot.
 */

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'you', 'are', 'was', 'have', 'from', 'what', 'how', 'can', 'please', 'use'])
const CJK = /[㐀-鿿豈-﫿]/

export function tokens(text: string): Set<string> {
  const out = new Set<string>()
  const s = text.toLowerCase()
  for (const w of s.match(/[a-z0-9][a-z0-9_.-]*[a-z0-9]|[a-z0-9]/g) ?? []) {
    if (w.length < 2 || STOP.has(w)) continue
    out.add(w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w)
  }
  // CJK runs → bigrams (single characters for one-character runs)
  for (const run of s.match(/[㐀-鿿豈-﫿]+/g) ?? []) {
    if (run.length === 1) out.add(run)
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2))
  }
  return out
}

export const hasCjk = (s: string) => CJK.test(s)

/** Lower-cased host without "www.", or null for non-web URLs. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const u = new URL(url)
    if (!/^https?:$/.test(u.protocol)) return null
    return u.hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

/** Normalises what the user/agent typed as a site scope ("https://www.Taobao.com/x" → "taobao.com"). */
export function normalizeScope(scope: string | null | undefined): string | null {
  if (!scope?.trim()) return null
  const s = scope.trim().toLowerCase()
  return hostOf(/^https?:\/\//.test(s) ? s : `https://${s}`) ?? s
}

/** A site memory for "taobao.com" also applies on "item.taobao.com". */
export const siteMatches = (scope: string | null, host: string | null) => !!scope && !!host && (host === scope || host.endsWith(`.${scope}`))

// ---------- relevance

interface Indexed {
  m: Memory
  title: Set<string>
  body: Set<string>
}

export class MemoryIndex {
  private items: Indexed[]
  private df = new Map<string, number>()

  constructor(memories: Memory[]) {
    this.items = memories.map((m) => ({ m, title: tokens(`${m.title} ${m.scope ?? ''}`), body: tokens(m.content) }))
    for (const it of this.items) for (const t of new Set([...it.title, ...it.body])) this.df.set(t, (this.df.get(t) ?? 0) + 1)
  }

  /**
   * ≥ 1 for every token, higher for rarer ones. (A plain log(N/df) collapses when there are only a
   * handful of memories — exactly when a new user has one or two — and nothing clears the threshold.)
   */
  private idf(t: string): number {
    return 1 + Math.log((this.items.length + 1) / ((this.df.get(t) ?? 0) + 1))
  }

  /**
   * Memories relevant to `query`, best first. The score is the idf mass of shared tokens (title
   * counts double); `minScore` (default: more than one shared body token) keeps a single coincidental
   * token from pulling in unrelated memories.
   */
  search(query: string, opts: { kinds?: MemoryKind[]; limit?: number; minScore?: number } = {}): { m: Memory; score: number }[] {
    const q = tokens(query)
    if (!q.size) return []
    const out: { m: Memory; score: number }[] = []
    for (const it of this.items) {
      if (opts.kinds && !opts.kinds.includes(it.m.kind)) continue
      let s = 0
      for (const t of q) {
        if (it.title.has(t)) s += 2 * this.idf(t)
        else if (it.body.has(t)) s += this.idf(t)
      }
      if (s <= 0) continue
      // light preference for pinned and recently useful memories
      s *= 1 + (it.m.pinned ? 0.3 : 0) + Math.min(it.m.useCount, 20) * 0.01
      out.push({ m: it.m, score: s })
    }
    return out
      .filter((x) => x.score >= (opts.minScore ?? 1.2))
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit ?? 8)
  }
}

// ---------- dedupe

/** Token overlap of two memories (0–1), used to turn a near-duplicate save into an update. */
export function similarity(a: Pick<Memory, 'title' | 'content'>, b: Pick<Memory, 'title' | 'content'>): number {
  const x = tokens(`${a.title} ${a.content}`)
  const y = tokens(`${b.title} ${b.content}`)
  if (!x.size || !y.size) return 0
  let common = 0
  for (const t of x) if (y.has(t)) common++
  return common / Math.min(x.size, y.size)
}

/** The existing memory a new one duplicates, if any (same kind and site, same title or ≥ 0.75 overlap). */
export function findDuplicate(existing: Memory[], m: Pick<Memory, 'kind' | 'title' | 'content' | 'scope'>): Memory | null {
  let best: { m: Memory; s: number } | null = null
  for (const e of existing) {
    if (e.kind !== m.kind || (e.scope ?? null) !== (m.scope ?? null)) continue
    if (e.title.trim().toLowerCase() === m.title.trim().toLowerCase()) return e
    const s = similarity(e, m)
    if (s >= 0.75 && (!best || s > best.s)) best = { m: e, s }
  }
  return best?.m ?? null
}

// ---------- safety

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/, 'API Key'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'GitHub Token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS Key'],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/, 'Slack Token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, 'JWT'],
  [/(密码|口令|passwd|password|pwd|验证码|动态码|otp|pin\s*码?|cvv|安全码)\s*(是|为|:|：|=)\s*\S{3,}/i, '密码或验证码'],
  [/(?<!\d)\d{17}[\dXx](?!\d)/, '身份证号'],
  [/(?<!\d)(?:\d[ -]?){15,18}\d(?!\d)/, '银行卡号'],
]

/** Name of the kind of secret found in `text`, or null. Memories never store these. */
export function findSecret(text: string): string | null {
  for (const [re, name] of SECRET_PATTERNS) if (re.test(text)) return name
  return null
}

// ---------- grounding (memory poisoning defence)

const norm = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')

const pairs = (s: string) => {
  const out = new Set<string>()
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2))
  return out
}

/**
 * Whether `evidence` really comes from what the user wrote (not from a web page or the agent's
 * reply). Tolerates punctuation / spacing differences and small edits (a dropped "的"): at least 80%
 * of the quote's character pairs must occur in one of the user's messages.
 */
export function quotedFrom(evidence: string | null | undefined, userTexts: string[]): boolean {
  const q = norm(evidence ?? '')
  if (q.length < (hasCjk(q) ? 2 : 4)) return false
  const qp = pairs(q)
  return userTexts.some((t) => {
    const u = norm(t)
    if (u.includes(q)) return true
    if (q.length < 4) return false
    const up = pairs(u)
    let hit = 0
    for (const p of qp) if (up.has(p)) hit++
    return hit / qp.size >= 0.8
  })
}

// ---------- prompt

export const KIND_LABEL: Record<MemoryKind, string> = { profile: '关于用户', preference: '偏好', knowledge: '知识', site: '站点经验' }

const line = (m: Memory) => `- [${m.id.slice(0, 8)}] ${m.title}：${m.content}`

/** Budgeted memory section of the system prompt. */
export function memoryPrompt(always: Memory[], relevant: Memory[], sites: Memory[], budget = 6000): string {
  const parts: string[] = []
  let left = budget
  const add = (title: string, list: Memory[]) => {
    const lines: string[] = []
    for (const m of list) {
      const l = line(m)
      if (l.length > left) break
      left -= l.length
      lines.push(l)
    }
    if (lines.length) parts.push(`### ${title}\n${lines.join('\n')}`)
  }
  add(
    '关于用户',
    always.filter((m) => m.kind === 'profile'),
  )
  add(
    '用户偏好（请遵循）',
    always.filter((m) => m.kind === 'preference'),
  )
  add('与本次对话相关的记忆', relevant)
  add('当前网站的操作经验', sites)
  return parts.join('\n\n')
}
