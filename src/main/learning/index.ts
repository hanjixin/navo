import { db, json, kv } from '../core/db'
import { log } from '../core/logger'
import { getSettings } from '../core/settings'
import { memory } from '../memory/memory-service'
import { LearningScheduler, type LearnTurn } from './scheduler'

const KEY = 'learning.pending.'

/** The app's learning scheduler: pending turns live in the kv table, processing goes to memory (and skills). */
export const learning = new LearningScheduler({
  // AB_MEMORY_IDLE_MS shortens the wait in tests
  idleMs: () => Number(process.env.AB_MEMORY_IDLE_MS) || Math.max(1, getSettings().memory.idleMinutes) * 60_000,
  store: {
    load: () => {
      const rows = db().prepare('SELECT key, value FROM kv WHERE key LIKE ?').all(`${KEY}%`) as { key: string; value: string }[]
      return Object.fromEntries(rows.map((r) => [r.key.slice(KEY.length), json.parse<LearnTurn[]>(r.value) ?? []]))
    },
    save: (threadId, turns) => kv.set(KEY + threadId, turns),
    clear: (threadId) =>
      void db()
        .prepare('DELETE FROM kv WHERE key = ?')
        .run(KEY + threadId),
  },
  flush: async (threadId, turns, reason) => {
    const thread = db().prepare('SELECT title, model_id FROM threads WHERE id = ?').get(threadId) as { title: string; model_id: string | null } | undefined
    if (!thread) return
    log.info(`[learning] ${thread.title.slice(0, 30)}: ${turns.length} turn(s), ${reason}`)
    const latest = turns[turns.length - 1]
    await memory.learn(
      threadId,
      thread.title,
      thread.model_id,
      { userText: latest.userText, reply: latest.reply, actions: latest.actions, earlier: turns.slice(0, -1) },
      // the agent already handled memory itself in every one of these turns: only the journal is due
      { journalOnly: turns.every((t) => t.journalOnly) },
    )
    // enough new memories since the last tidy-up? merge duplicates, settle contradictions
    void memory.maybeConsolidate(thread.model_id)
  },
  onError: (threadId, err) => log.warn(`[learning] ${threadId}: ${(err as Error).message}`),
})
