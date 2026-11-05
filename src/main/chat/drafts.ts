import type Database from 'better-sqlite3'
import type { ChatDraft, DraftSaveInput, DraftScope } from '@shared/reliability'
import { db } from '../core/db'
import { emit } from '../core/ipc'

export function draftKey(scope: DraftScope): string {
  if (!scope || !['main', 'quick'].includes(scope.surface)) throw new Error('Invalid draft surface')
  if (scope.threadId && scope.projectId) throw new Error('A draft must have only one owner')
  return JSON.stringify([scope.surface, scope.threadId ? 'thread' : scope.projectId ? 'project' : 'new', scope.threadId || scope.projectId || ''])
}

export class DraftStore {
  constructor(private database: () => Database.Database = db) {}

  get(scope: DraftScope): ChatDraft {
    const row = this.database().prepare('SELECT data, version, updated_at FROM chat_drafts WHERE scope = ?').get(draftKey(scope)) as
      { data: string; version: number; updated_at: number } | undefined
    return row
      ? { ...JSON.parse(row.data), scope, version: row.version, updatedAt: row.updated_at }
      : { scope, text: '', fileIds: [], projectFiles: [], modelId: null, version: 0, updatedAt: 0 }
  }

  save(input: DraftSaveInput): ChatDraft {
    return this.database().transaction(() => {
      const current = this.get(input.scope)
      const sameEditor = !!input.editorId && input.editorId === current.editorId
      const incomingRevision = input.editRevision ?? 0
      if (sameEditor && incomingRevision <= (current.editRevision ?? 0)) return current
      if (current.version !== input.expectedVersion && !(sameEditor && incomingRevision > (current.editRevision ?? 0)))
        throw new Error('Draft changed; reload before saving')
      if (typeof input.text !== 'string' || !Array.isArray(input.fileIds) || !Array.isArray(input.projectFiles)) throw new Error('Invalid draft')
      const next: ChatDraft = {
        scope: input.scope,
        editorId: input.editorId,
        editRevision: input.editRevision,
        text: input.text,
        fileIds: [...new Set(input.fileIds)],
        projectFiles: input.projectFiles,
        modelId: input.modelId,
        version: current.version + 1,
        updatedAt: Date.now(),
      }
      this.database()
        .prepare(
          `INSERT INTO chat_drafts(scope, data, version, updated_at) VALUES(?, ?, ?, ?)
        ON CONFLICT(scope) DO UPDATE SET data = excluded.data, version = excluded.version, updated_at = excluded.updated_at`,
        )
        .run(draftKey(input.scope), JSON.stringify(next), next.version, next.updatedAt)
      emit('drafts.changed', input.scope)
      return next
    })()
  }

  clear(scope: DraftScope, version: number): boolean {
    return this.database().transaction(() => {
      const current = this.get(scope)
      if (current.version !== version) return false
      this.save({ scope, text: '', fileIds: [], projectFiles: [], modelId: current.modelId, expectedVersion: version })
      return true
    })()
  }

  move(source: DraftScope, target: DraftScope, version: number): { moved: boolean; draft: ChatDraft } {
    return this.database().transaction(() => {
      const from = this.get(source)
      const to = this.get(target)
      if (draftKey(source) === draftKey(target) || from.version !== version || to.text || to.fileIds.length || to.projectFiles.length)
        return { moved: false, draft: to }
      const draft = this.save({ ...from, editorId: undefined, editRevision: undefined, scope: target, expectedVersion: to.version })
      this.clear(source, version)
      return { moved: true, draft }
    })()
  }
}

export const drafts = new DraftStore()
