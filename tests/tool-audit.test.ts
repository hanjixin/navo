import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { finishToolAudit, listToolAudits, startToolAudit } from '../src/main/agent/tool-audit'

let db: DatabaseSync
afterEach(() => db?.close())

describe('tool audit trail', () => {
  it('records a tool lifecycle with project and execution provenance', () => {
    db = new DatabaseSync(':memory:')
    const source = readFileSync('src/main/core/db-core.ts', 'utf8').split('/** Opens')[0]
    for (const match of source.matchAll(/`([\s\S]*?)`/g)) db.exec(match[1])
    db.prepare('INSERT INTO threads(id,title,created_at,updated_at,hidden) VALUES(?,?,?,?,0)').run('thread', 'Thread', 1, 1)
    const id = startToolAudit(db as never, {
      threadId: 'thread',
      projectId: 'project',
      runId: 'run',
      executionId: 'execution',
      runtimeId: 'builtin',
      toolName: 'write_file',
      source: 'navo',
      startedAt: 10,
    })
    finishToolAudit(db as never, id, 'success', null, 20)
    expect(listToolAudits(db as never, 'thread')).toMatchObject([
      {
        id,
        threadId: 'thread',
        projectId: 'project',
        runId: 'run',
        executionId: 'execution',
        toolName: 'write_file',
        status: 'success',
        startedAt: 10,
        finishedAt: 20,
      },
    ])
  })
})
