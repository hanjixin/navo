import { hasMemorySignal } from '../memory/recall'

/**
 * When Navo looks back at a conversation to learn from it (memories, the daily journal, skills).
 *
 *   1. at once   — the user's message carries an explicit cue ("记住…", a correction, "以后都…")
 *   2. when idle — everything else waits until the conversation has been quiet for a while, the user
 *                  moves to another conversation, or enough turns have piled up; the whole stretch is
 *                  then looked at in one pass (fewer model calls, and things said across several
 *                  turns are seen together)
 *
 * Pending turns are persisted, so a restart picks up where it left off.
 */

export interface LearnTurn {
  userText: string
  reply: string
  /** what the agent did, e.g. "browser_navigate https://…" */
  actions: string[]
  /** the agent managed memory itself in this turn: only the journal needs it */
  journalOnly: boolean
  at: number
  /** files the agent read (skills are recognised by their path) */
  filesRead: string[]
  toolCalls: number
  toolErrors: number
}

export type FlushReason = 'signal' | 'idle' | 'count' | 'switch' | 'resume' | 'manual'

export interface SchedulerDeps {
  /** quiet time before a conversation's pending turns are processed */
  idleMs: () => number
  /** processes a conversation's pending turns (oldest first) */
  flush: (threadId: string, turns: LearnTurn[], reason: FlushReason) => Promise<void>
  store: {
    load: () => Record<string, LearnTurn[]>
    save: (threadId: string, turns: LearnTurn[]) => void
    clear: (threadId: string) => void
  }
  onError?: (threadId: string, err: unknown) => void
}

/** Turns without a cue are processed together once this many have piled up. */
export const MAX_PENDING_TURNS = 6
const RESUME_DELAY_MS = 5_000

export class LearningScheduler {
  private pending = new Map<string, LearnTurn[]>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private running = new Map<string, Promise<void>>()

  constructor(private deps: SchedulerDeps) {}

  /** A turn finished. Decides between "now" and "later". */
  submit(threadId: string, turn: LearnTurn): void {
    // the user has moved on from the other conversations: they won't get quieter than this
    for (const other of [...this.pending.keys()]) if (other !== threadId) void this.flush(other, 'switch')
    const turns = [...(this.pending.get(threadId) ?? []), turn]
    this.pending.set(threadId, turns)
    this.deps.store.save(threadId, turns)
    if (hasMemorySignal(turn.userText)) void this.flush(threadId, 'signal')
    else if (turns.length >= MAX_PENDING_TURNS) void this.flush(threadId, 'count')
    else this.arm(threadId, this.deps.idleMs(), 'idle')
  }

  private arm(threadId: string, ms: number, reason: FlushReason): void {
    this.disarm(threadId)
    this.timers.set(
      threadId,
      setTimeout(() => void this.flush(threadId, reason), ms),
    )
  }

  private disarm(threadId: string): void {
    const t = this.timers.get(threadId)
    if (t) clearTimeout(t)
    this.timers.delete(threadId)
  }

  /** Processes what is pending for a conversation now. Turns arriving meanwhile wait for the next pass. */
  async flush(threadId: string, reason: FlushReason): Promise<void> {
    this.disarm(threadId)
    const before = this.running.get(threadId)
    if (before) await before
    const turns = this.pending.get(threadId)
    if (!turns?.length) return
    this.pending.delete(threadId)
    const job = this.deps
      .flush(threadId, turns, reason)
      .catch((err) => this.deps.onError?.(threadId, err))
      .finally(() => {
        this.running.delete(threadId)
        // only now is it safe to forget them; a crash mid-pass re-processes rather than loses turns
        const newer = this.pending.get(threadId)
        if (newer?.length) this.deps.store.save(threadId, newer)
        else this.deps.store.clear(threadId)
      })
    this.running.set(threadId, job)
    await job
  }

  flushAll(reason: FlushReason = 'manual'): Promise<void[]> {
    return Promise.all([...this.pending.keys()].map((id) => this.flush(id, reason)))
  }

  /** After a restart: turns that were still waiting are processed shortly. */
  resume(): void {
    for (const [threadId, turns] of Object.entries(this.deps.store.load())) {
      if (!turns.length || this.pending.has(threadId)) continue
      this.pending.set(threadId, turns)
      this.arm(threadId, RESUME_DELAY_MS, 'resume')
    }
  }

  /** The conversation was deleted: nothing left to learn from. */
  drop(threadId: string): void {
    this.disarm(threadId)
    this.pending.delete(threadId)
    this.deps.store.clear(threadId)
  }

  pendingCount(threadId: string): number {
    return this.pending.get(threadId)?.length ?? 0
  }
}
