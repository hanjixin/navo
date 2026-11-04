import type { Project, ProjectInput, ProjectSummary, ProjectDetail, Thread } from '@shared/types'
import { db } from '../core/db'
import { newId } from '../core/id'
import { emit } from '../core/ipc'
import { validateWorkingDirectory } from './workspace-directory'
import { t } from '@shared/i18n'

type Row = { id: string; name: string; description: string; created_at: number; updated_at: number; working_directory: string | null }

const toProject = (r: Row): Project => ({
  workingDirectory: r.working_directory ?? null,
  id: r.id,
  name: r.name,
  description: r.description,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

type SummaryRow = Row & { thread_count: number; artifact_count: number; last_activity_at: number }
const toSummary = (r: SummaryRow): ProjectSummary => ({
  ...toProject(r),
  threadCount: r.thread_count,
  artifactCount: r.artifact_count,
  lastActivityAt: r.last_activity_at,
})
const SUMMARY_SQL = `SELECT p.*,
      (SELECT COUNT(*) FROM threads t WHERE t.project_id=p.id AND t.hidden=0) AS thread_count,
      (SELECT COUNT(*) FROM outputs o JOIN threads t ON t.id=o.thread_id WHERE t.project_id=p.id) AS artifact_count,
      MAX(p.updated_at, COALESCE((SELECT MAX(t.updated_at) FROM threads t WHERE t.project_id=p.id AND t.hidden=0),0),
        COALESCE((SELECT MAX(o.at) FROM outputs o JOIN threads t ON t.id=o.thread_id WHERE t.project_id=p.id),0)) AS last_activity_at
      FROM projects p`

class ProjectService {
  list(): ProjectSummary[] {
    return (db().prepare(`${SUMMARY_SQL} ORDER BY last_activity_at DESC, p.name COLLATE NOCASE`).all() as SummaryRow[]).map(toSummary)
  }

  basic(id: string): Project | null {
    const row = db().prepare('SELECT * FROM projects WHERE id=?').get(id) as Row | undefined
    return row ? toProject(row) : null
  }

  get(id: string): ProjectDetail | null {
    const row = db().prepare(`${SUMMARY_SQL} WHERE p.id=?`).get(id) as SummaryRow | undefined
    if (!row) return null
    const project = toSummary(row)
    const threads = db()
      .prepare(
        'SELECT id, title, model_id AS modelId, project_id AS projectId, created_at AS createdAt, updated_at AS updatedAt FROM threads WHERE project_id=? AND hidden=0 ORDER BY updated_at DESC',
      )
      .all(id) as Thread[]
    return { ...project, threads }
  }

  exists(id: string): boolean {
    return !!db().prepare('SELECT 1 FROM projects WHERE id = ?').get(id)
  }

  save(input: ProjectInput): Project {
    if (!input || typeof input.name !== 'string') throw new Error(t('项目名称必须是文本'))
    if (input.description != null && typeof input.description !== 'string') throw new Error(t('项目描述必须是文本'))
    const name = input.name.trim()
    if (!name) throw new Error(t('项目名称不能为空'))
    if (name.length > 120) throw new Error(t('项目名称不能超过 120 个字符'))
    const description = (input.description ?? '').trim()
    if (description.length > 4000) throw new Error(t('项目描述不能超过 4000 个字符'))
    const id = input.id ?? newId()
    const now = Date.now()
    const existing = this.basic(id)
    if (input.id && !existing) throw new Error(t('项目不存在'))
    const workingDirectory =
      input.workingDirectory === undefined
        ? (existing?.workingDirectory ?? null)
        : input.workingDirectory === null
          ? null
          : validateWorkingDirectory(input.workingDirectory)
    const duplicate = db().prepare('SELECT id FROM projects WHERE name = ? COLLATE NOCASE AND id != ?').get(name, id) as { id: string } | undefined
    if (duplicate) throw new Error(t('项目名称已存在'))
    db()
      .prepare(
        `INSERT INTO projects(id, name, description, created_at, updated_at, working_directory) VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, updated_at = excluded.updated_at, working_directory = excluded.working_directory`,
      )
      .run(id, name, description, existing?.createdAt ?? now, now, workingDirectory)
    emit('projects.changed')
    emit('threads.changed')
    emit('artifacts.changed')
    return this.basic(id)!
  }

  delete(id: string): void {
    if (!this.exists(id)) return
    db().prepare('DELETE FROM projects WHERE id = ?').run(id)
    emit('projects.changed')
    emit('threads.changed')
    emit('artifacts.changed')
  }
}
export const projects = new ProjectService()
