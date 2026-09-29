import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative, sep } from 'node:path'
import type { DayEntry, Memory, MemoryInput, MemoryKind, MemoryLearned, MemoryRef } from '@shared/types'
import { db, kv } from '../core/db'
import { newId } from '../core/id'
import { emit } from '../core/ipc'
import { log } from '../core/logger'
import { paths } from '../core/paths'
import { getSettings } from '../core/settings'
import { createChatModel, models } from '../models/registry'
import { extractionMessages, parseJournal, parseOps, type Exchange } from './extract'
import { findDuplicate, findSecret, hostOf, KIND_LABEL, MemoryIndex, memoryPrompt, normalizeScope, quotedFrom, siteMatches } from './recall'

const KINDS: MemoryKind[] = ['profile', 'preference', 'knowledge', 'site']
const MAX_TITLE = 60
const MAX_CONTENT = 1000

interface Row {
  id: string
  kind: MemoryKind
  title: string
  content: string
  scope: string | null
  status: 'active' | 'pending'
  pinned: number
  source_thread: string | null
  source_title: string | null
  created_at: number
  updated_at: number
  last_used_at: number | null
  use_count: number
}

const toMemory = (r: Row): Memory => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  content: r.content,
  scope: r.scope,
  status: r.status,
  pinned: !!r.pinned,
  source: r.source_thread ? { threadId: r.source_thread, title: r.source_title ?? '' } : null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastUsedAt: r.last_used_at,
  useCount: r.use_count,
})

type Source = { threadId: string; title: string } | null

const SMALL_TALK =
  /^(谢谢(你|啦)?|多谢|感谢|好的?|好滴|嗯+|哦+|噢+|ok(ay)?|thanks?( you)?|thx|收到|明白了?|知道了|了解|行|可以|没问题|再见|拜拜|bye|hi|hello|hey|你好|您好|在吗|早上好|晚安|哈+|👍|🙏)[\s!！。.~～,，]*$/i
/** A message that is only a pleasantry ("谢谢", "好的", "ok") — not worth a memory pass. */
export const isSmallTalk = (text: string) => SMALL_TALK.test(text.trim())

interface DayRow {
  day: string
  thread_id: string
  thread_title: string
  text: string
  updated_at: number
}
const toDay = (r: DayRow): DayEntry => ({ day: r.day, threadId: r.thread_id, threadTitle: r.thread_title, text: r.text, updatedAt: r.updated_at })

/** Local calendar day as YYYY-MM-DD, offset by `delta` days. */
export function localDay(delta = 0, now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + delta)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
type Undo = { id: string; before: Memory | null }

/** What a run gets from memory: a system-prompt section and the memories it was built from. */
export interface RunMemory {
  prompt: string
  refs: MemoryRef[]
}

class MemoryService {
  /** automatic learning batches that can still be undone (from the toast) */
  private batches = new Map<string, Undo[]>()
  /** hosts whose site notes were already shown in a run */
  private siteSeen = new Map<string, Set<string>>()
  private learning = new Set<string>()

  // ---------- storage

  list(): Memory[] {
    return (db().prepare('SELECT * FROM memories ORDER BY pinned DESC, updated_at DESC').all() as Row[]).map(toMemory)
  }

  private active(): Memory[] {
    return this.list().filter((m) => m.status === 'active')
  }

  get(id: string): Memory | null {
    const r = db().prepare('SELECT * FROM memories WHERE id = ?').get(id) as Row | undefined
    return r ? toMemory(r) : null
  }

  private changed(): void {
    emit('memory.changed')
  }

  /** Validates and normalises input; throws with a message the agent / UI can show. */
  private clean(input: MemoryInput): Required<Pick<MemoryInput, 'kind' | 'title' | 'content'>> & { scope: string | null } {
    if (!KINDS.includes(input.kind)) throw new Error(`未知的记忆类型：${input.kind}`)
    const title = input.title?.trim().replace(/\s+/g, ' ')
    const content = input.content?.trim()
    if (!title) throw new Error('记忆需要标题')
    if (!content) throw new Error('记忆内容不能为空')
    if (title.length > MAX_TITLE) throw new Error(`标题太长（最多 ${MAX_TITLE} 字）`)
    if (content.length > MAX_CONTENT) throw new Error(`内容太长（最多 ${MAX_CONTENT} 字），请只保留要点`)
    const secret = findSecret(`${title}\n${content}`)
    if (secret) throw new Error(`记忆中不能保存${secret}等敏感信息`)
    const scope = input.kind === 'site' ? normalizeScope(input.scope) : null
    if (input.kind === 'site' && !scope) throw new Error('站点经验需要指定网站域名')
    return { kind: input.kind, title, content, scope }
  }

  /**
   * Creates or edits a memory. Without an id, a near-duplicate of an existing memory (same kind and
   * site, same title or mostly the same words) is updated instead of adding a second copy.
   */
  save(
    input: MemoryInput & { id?: string },
    opts: { source?: Source; status?: 'active' | 'pending'; keepExisting?: boolean } = {},
  ): { memory: Memory; op: 'add' | 'update' | 'none'; before: Memory | null } {
    const c = this.clean(input)
    const now = Date.now()
    const target = input.id ? this.get(input.id) : findDuplicate(this.list(), c)
    if (input.id && !target) throw new Error('记忆不存在')
    // unverified input never rewrites what the user already has
    if (target && opts.keepExisting && !input.id) return { memory: target, op: 'none', before: target }
    if (target) {
      db()
        .prepare('UPDATE memories SET kind = ?, title = ?, content = ?, scope = ?, pinned = COALESCE(?, pinned), updated_at = ? WHERE id = ?')
        .run(c.kind, c.title, c.content, c.scope, input.pinned == null ? null : input.pinned ? 1 : 0, now, target.id)
      this.changed()
      return { memory: this.get(target.id)!, op: 'update', before: target }
    }
    const id = newId()
    db()
      .prepare(
        `INSERT INTO memories(id, kind, title, content, scope, status, pinned, source_thread, source_title, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        c.kind,
        c.title,
        c.content,
        c.scope,
        opts.status ?? 'active',
        input.pinned ? 1 : 0,
        opts.source?.threadId ?? null,
        opts.source?.title ?? null,
        now,
        now,
      )
    this.changed()
    return { memory: this.get(id)!, op: 'add', before: null }
  }

  delete(id: string): void {
    db().prepare('DELETE FROM memories WHERE id = ?').run(id)
    this.changed()
  }

  pin(id: string, pinned: boolean): void {
    db()
      .prepare('UPDATE memories SET pinned = ? WHERE id = ?')
      .run(pinned ? 1 : 0, id)
    this.changed()
  }

  confirm(ids: string[]): void {
    const st = db().prepare("UPDATE memories SET status = 'active', updated_at = ? WHERE id = ?")
    db().transaction(() => ids.forEach((id) => st.run(Date.now(), id)))()
    this.changed()
  }

  clear(): void {
    db().prepare('DELETE FROM memories').run()
    db().prepare('DELETE FROM memory_days').run()
    this.batches.clear()
    this.changed()
  }

  /** Reverts an automatic learning batch: added memories are removed, updated / deleted ones restored. */
  undo(batchId: string): void {
    const batch = this.batches.get(batchId)
    if (!batch) throw new Error('这次记忆已无法撤销')
    db().transaction(() => {
      for (const u of [...batch].reverse()) {
        db().prepare('DELETE FROM memories WHERE id = ?').run(u.id)
        if (u.before) this.restore(u.before)
      }
    })()
    this.batches.delete(batchId)
    this.changed()
  }

  /** Puts a deleted memory back exactly as it was (undo on the Memory page). */
  undelete(m: Memory): void {
    if (this.get(m.id)) return
    this.restore(m)
    this.changed()
  }

  private restore(m: Memory): void {
    db()
      .prepare(
        `INSERT INTO memories(id, kind, title, content, scope, status, pinned, source_thread, source_title, created_at, updated_at, last_used_at, use_count)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        m.id,
        m.kind,
        m.title,
        m.content,
        m.scope,
        m.status,
        m.pinned ? 1 : 0,
        m.source?.threadId ?? null,
        m.source?.title ?? null,
        m.createdAt,
        m.updatedAt,
        m.lastUsedAt,
        m.useCount,
      )
  }

  search(query: string, kind?: MemoryKind, limit = 10): Memory[] {
    const all = this.active().filter((m) => !kind || m.kind === kind)
    if (!query.trim()) return all.slice(0, limit)
    return new MemoryIndex(all).search(query, { limit, minScore: 0.5 }).map((x) => x.m)
  }

  // ---------- per conversation

  threadEnabled(threadId: string): boolean {
    return getSettings().memory.enabled && kv.get(`thread.memory.${threadId}`, true)
  }

  setThreadEnabled(threadId: string, enabled: boolean): void {
    kv.set(`thread.memory.${threadId}`, enabled)
  }

  /**
   * Memory for one run: profile and preferences always, pinned memories, the knowledge most relevant
   * to the message, and the experience noted for the site the conversation's tab is on.
   */
  forRun(threadId: string, text: string, url: string | null): RunMemory | null {
    this.siteSeen.set(threadId, new Set())
    if (!this.threadEnabled(threadId)) return null
    const all = this.active()
    const always = all
      .filter((m) => m.kind === 'profile' || m.kind === 'preference')
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.useCount - a.useCount || b.updatedAt - a.updatedAt)
    const pinned = all.filter((m) => m.pinned && m.kind === 'knowledge')
    const relevant = new MemoryIndex(all.filter((m) => m.kind === 'knowledge' && !m.pinned)).search(text, { limit: 6 }).map((x) => x.m)
    const host = hostOf(url)
    const sites = all.filter((m) => m.kind === 'site' && siteMatches(m.scope, host))
    if (host) this.siteSeen.get(threadId)!.add(host)
    const picked = [...pinned, ...relevant, ...sites]
    this.markUsed(picked.map((m) => m.id))
    return {
      prompt: [memoryPrompt(always, [...pinned, ...relevant], sites), this.recentDaysPrompt(threadId)].filter(Boolean).join('\n\n'),
      refs: picked.map((m) => ({ id: m.id, title: m.title, kind: m.kind })),
    }
  }

  /** Today's journal from other conversations; earlier days are recalled on demand with memory_daily. */
  private recentDaysPrompt(threadId: string): string {
    const today = localDay()
    const lines = this.days({ from: today, to: today, limit: 12 })
      .filter((e) => e.threadId !== threadId)
      .map((e) => `- 「${e.threadTitle}」${e.text}`)
    return lines.length ? `### 今天的日记（昨天及更早的按需用 memory_daily 查询）\n${lines.join('\n')}` : ''
  }

  /** Site notes to append to a navigation result, once per host per run. */
  siteNotesOnce(threadId: string | undefined, url: string): string {
    if (!threadId || !this.threadEnabled(threadId)) return ''
    const host = hostOf(url)
    const seen = this.siteSeen.get(threadId) ?? new Set<string>()
    this.siteSeen.set(threadId, seen)
    if (!host || seen.has(host)) return ''
    seen.add(host)
    const notes = this.active().filter((m) => m.kind === 'site' && siteMatches(m.scope, host))
    if (!notes.length) return ''
    this.markUsed(notes.map((m) => m.id))
    return `\n\n[站点经验] 之前在 ${host} 记下的要点：\n${notes.map((m) => `- ${m.title}：${m.content}`).join('\n')}`
  }

  private markUsed(ids: string[]): void {
    if (!ids.length) return
    const st = db().prepare('UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?')
    db().transaction(() => ids.forEach((id) => st.run(Date.now(), id)))()
  }

  // ---------- automatic learning

  /** Runs after a reply (fire and forget): proposes and applies memory changes, then tells the UI. */
  /**
   * Runs after a reply (fire and forget): one model call proposes memory changes and updates the
   * conversation's line in today's journal. `journalOnly`: the agent already managed memory itself.
   */
  async learn(
    threadId: string,
    threadTitle: string,
    modelId: string | null,
    ex: Exchange,
    opts: { journalOnly?: boolean } = {},
  ): Promise<MemoryLearned | null> {
    const s = getSettings().memory
    const wantOps = s.autoLearn && !opts.journalOnly
    if ((!wantOps && !s.daily) || !this.threadEnabled(threadId) || this.learning.has(threadId)) return null
    // nothing to learn from pleasantries: skip the model call entirely
    if (ex.userText.trim().length < 2 || (isSmallTalk(ex.userText) && !ex.actions.length)) return null
    this.learning.add(threadId)
    try {
      const all = this.list()
      const related = new MemoryIndex(all).search(`${ex.userText}\n${ex.reply.slice(0, 800)}`, { limit: 12, minScore: 0.5 }).map((x) => x.m)
      const today = localDay()
      const todayLog = this.dayEntry(today, threadId)?.text ?? null
      // a cheaper model can be set for this pass; fall back to the conversation's if it was removed
      const model = s.modelId && models.get(s.modelId) ? s.modelId : modelId
      const res = await createChatModel(model).invoke(extractionMessages(wantOps ? related : [], { ...ex, todayLog }))
      const text = typeof res.content === 'string' ? res.content : (res.content as { text?: string }[]).map((b) => b.text ?? '').join('')
      const journal = s.daily ? parseJournal(text) : null
      if (journal && !findSecret(journal)) this.writeDay(today, threadId, threadTitle, journal)
      const ops = wantOps ? parseOps(text, new Set(related.map((m) => m.id))) : []
      if (!ops.length) return null
      const batchId = newId()
      const undo: Undo[] = []
      const items: MemoryLearned['items'] = []
      const status = s.review ? 'pending' : 'active'
      // memories about the user must quote the user's own words; anything else (web pages, the
      // agent's reply) is either held for confirmation (adds) or not applied (updates / deletes)
      const grounded = (kind: MemoryKind, ev: string | null | undefined) => kind === 'site' || quotedFrom(ev, [ex.userText])
      for (const op of ops) {
        try {
          if (op.op === 'delete') {
            const before = this.get(op.id)
            if (!before || !grounded(before.kind, op.evidence)) continue
            // in review mode deletions are not applied silently either
            if (s.review) continue
            this.delete(op.id)
            undo.push({ id: op.id, before })
            items.push({ id: op.id, title: before.title, op: 'delete' })
          } else if (op.op === 'update') {
            const before = this.get(op.id)
            if (!before || !grounded(before.kind, op.evidence)) continue
            const r = this.save({ id: op.id, kind: before.kind, title: op.title || before.title, content: op.content, scope: before.scope })
            undo.push({ id: op.id, before })
            items.push({ id: op.id, title: r.memory.title, op: 'update' })
          } else {
            const ok = grounded(op.kind, op.evidence)
            const r = this.save(
              { kind: op.kind, title: op.title, content: op.content, scope: op.site ?? null },
              { source: { threadId, title: threadTitle }, status: ok ? status : 'pending', keepExisting: !ok },
            )
            if (r.op === 'none') continue
            undo.push({ id: r.memory.id, before: r.before })
            items.push({ id: r.memory.id, title: r.memory.title, op: r.op, pending: r.memory.status === 'pending' })
            if (!ok) log.info(`[memory] "${op.title}" is not backed by the user's words: held for confirmation`)
          }
        } catch (err) {
          log.info(`[memory] skipped a learned memory: ${(err as Error).message}`)
        }
      }
      if (!items.length) return null
      this.batches.set(batchId, undo)
      const learned: MemoryLearned = { threadId, batchId, items, pending: items.every((i) => i.pending) }
      emit('memory.learned', learned)
      return learned
    } catch (err) {
      log.warn(`[memory] learning failed: ${(err as Error).message}`)
      return null
    } finally {
      this.learning.delete(threadId)
    }
  }

  /** Tells the UI a memory is waiting for confirmation (toast with a link to the Memory page). */
  announcePending(threadId: string, m: Memory): void {
    emit('memory.learned', { threadId, batchId: newId(), items: [{ id: m.id, title: m.title, op: 'add', pending: true }], pending: true })
  }

  /**
   * Development / evaluation: what automatic learning would do for an exchange, against a given set
   * of existing memories, without touching the store.
   */
  async dryRun(ex: Exchange, existing: Memory[], modelId: string | null = null) {
    const res = await createChatModel(modelId).invoke(extractionMessages(existing, ex))
    const raw = typeof res.content === 'string' ? res.content : (res.content as { text?: string }[]).map((b) => b.text ?? '').join('')
    const ops = parseOps(raw, new Set(existing.map((m) => m.id))).map((op) => {
      const kind = op.op === 'add' ? op.kind : existing.find((m) => m.id === op.id)?.kind
      const content = op.op === 'delete' ? '' : op.content
      return {
        ...op,
        grounded: kind === 'site' || quotedFrom(op.evidence, [ex.userText]),
        secret: findSecret(`${op.op === 'add' ? op.title : ''}\n${content}`),
      }
    })
    return { raw, ops, journal: parseJournal(raw) }
  }

  // ---------- daily journal

  private dayEntry(day: string, threadId: string): DayEntry | null {
    const r = db().prepare('SELECT * FROM memory_days WHERE day = ? AND thread_id = ?').get(day, threadId) as DayRow | undefined
    return r ? toDay(r) : null
  }

  private writeDay(day: string, threadId: string, threadTitle: string, text: string): void {
    db()
      .prepare(
        `INSERT INTO memory_days(day, thread_id, thread_title, text, updated_at) VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(day, thread_id) DO UPDATE SET text = excluded.text, thread_title = excluded.thread_title, updated_at = excluded.updated_at`,
      )
      .run(day, threadId, threadTitle, text, Date.now())
    this.changed()
  }

  /** Journal entries, newest day first (within a day: latest activity first). */
  days(opts: { limit?: number; from?: string; to?: string } = {}): DayEntry[] {
    const rows = db()
      .prepare('SELECT * FROM memory_days WHERE day >= ? AND day <= ? ORDER BY day DESC, updated_at DESC LIMIT ?')
      .all(opts.from ?? '0000-00-00', opts.to ?? '9999-99-99', opts.limit ?? 500) as DayRow[]
    return rows.map(toDay)
  }

  editDay(day: string, threadId: string, text: string): void {
    const t = text.trim()
    if (!t) return this.deleteDay(day, threadId)
    const secret = findSecret(t)
    if (secret) throw new Error(`日记中不能保存${secret}等敏感信息`)
    const e = this.dayEntry(day, threadId)
    if (!e) throw new Error('这条日记不存在')
    this.writeDay(day, threadId, e.threadTitle, t.slice(0, 200))
  }

  deleteDay(day: string, threadId: string): void {
    db().prepare('DELETE FROM memory_days WHERE day = ? AND thread_id = ?').run(day, threadId)
    this.changed()
  }

  /** A deleted conversation takes its journal lines with it (learned memories stay). */
  forgetThread(threadId: string): void {
    const n = db().prepare('DELETE FROM memory_days WHERE thread_id = ?').run(threadId).changes
    if (n) this.changed()
  }

  // ---------- setup

  /**
   * First start with the new store: import the old /memories/ Markdown files (AGENTS.md bullets
   * become separate preferences, other files become knowledge), or seed the Chinese-reply default.
   */
  ensureDefaults(): void {
    if (kv.get('memory.migrated', false)) return
    const imported: MemoryInput[] = []
    const root = paths.memories
    if (existsSync(root)) {
      const walk = (d: string): string[] =>
        readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : /\.(md|txt)$/i.test(e.name) ? [join(d, e.name)] : []))
      for (const f of walk(root)) {
        if (statSync(f).size > 200_000) continue
        const text = readFileSync(f, 'utf8')
        if (basename(f) === 'AGENTS.md' && relative(root, f) === 'AGENTS.md') {
          for (const b of text.split('\n').filter((l) => /^\s*[-*]\s+\S/.test(l))) {
            const content = b.replace(/^\s*[-*]\s+/, '').trim()
            imported.push({ kind: 'preference', title: content.slice(0, 16), content })
          }
        } else if (text.trim()) {
          imported.push({
            kind: 'knowledge',
            title: relative(root, f)
              .split(sep)
              .join('/')
              .replace(/\.(md|txt)$/i, '')
              .slice(0, MAX_TITLE),
            content: text.trim().slice(0, MAX_CONTENT),
          })
        }
      }
    }
    if (!imported.length && !this.list().length) imported.push({ kind: 'preference', title: '回复语言', content: '默认使用中文回复。' })
    for (const m of imported) {
      try {
        this.save(m)
      } catch (err) {
        log.info(`[memory] not imported: ${(err as Error).message}`)
      }
    }
    if (imported.length) log.info(`[memory] imported ${imported.length} memories`)
    kv.set('memory.migrated', true)
  }
}

export const memory = new MemoryService()
export { KIND_LABEL }
