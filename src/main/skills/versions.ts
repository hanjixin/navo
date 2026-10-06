import type { SkillVersion, SkillVersionSource } from '@shared/types'
import { db } from '../core/db'
import { newId } from '../core/id'

interface Row {
  skill: string
  version: number
  content: string
  at: number
  source: SkillVersionSource
  reason: string | null
  thread_id: string | null
}
const toVersion = (r: Row): SkillVersion => ({
  skill: r.skill,
  version: r.version,
  content: r.content,
  at: r.at,
  source: r.source,
  reason: r.reason ?? '',
  threadId: r.thread_id,
})

/** Every state a local skill has been in: who changed it, why, and the full text — for diffs and rollback. */
export const skillVersions = {
  history(skill: string): SkillVersion[] {
    return (db().prepare('SELECT * FROM skill_versions WHERE skill = ? ORDER BY version DESC').all(skill) as Row[]).map(toVersion)
  },
  latest(skill: string): SkillVersion | null {
    const r = db().prepare('SELECT * FROM skill_versions WHERE skill = ? ORDER BY version DESC LIMIT 1').get(skill) as Row | undefined
    return r ? toVersion(r) : null
  },
  get(skill: string, version: number): SkillVersion | null {
    const r = db().prepare('SELECT * FROM skill_versions WHERE skill = ? AND version = ?').get(skill, version) as Row | undefined
    return r ? toVersion(r) : null
  },
  /** Records a new version unless the text is unchanged; returns the current version number. */
  record(skill: string, content: string, source: SkillVersionSource, reason = '', threadId: string | null = null): number {
    const last = this.latest(skill)
    if (last?.content === content) return last.version
    const version = (last?.version ?? 0) + 1
    db()
      .prepare('INSERT INTO skill_versions(id, skill, version, content, at, source, reason, thread_id) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
      .run(newId(), skill, version, content, Date.now(), source, reason, threadId)
    return version
  },
  forget(skill: string): void {
    db().prepare('DELETE FROM skill_versions WHERE skill = ?').run(skill)
    db().prepare('DELETE FROM skill_runs WHERE skill = ?').run(skill)
    db().prepare("UPDATE skill_proposals SET status = 'rejected' WHERE skill = ? AND status = 'pending'").run(skill)
  },
}
