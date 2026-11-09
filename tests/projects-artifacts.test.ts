import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const dbSource = readFileSync('src/main/core/db-core.ts', 'utf8')
const ipcSource = readFileSync('src/shared/ipc-contract.ts', 'utf8')
const typesSource = readFileSync('src/shared/types.ts', 'utf8')

describe('projects and artifacts contracts', () => {
  it('adds a project migration with nullable thread ownership', () => {
    expect(dbSource).toMatch(/CREATE TABLE projects\s*\(/)
    expect(dbSource).toMatch(/name TEXT NOT NULL/)
    expect(dbSource).toMatch(/description TEXT NOT NULL/)
    expect(dbSource).toMatch(/ALTER TABLE threads ADD COLUMN project_id TEXT REFERENCES projects\(id\) ON DELETE SET NULL/)
  })

  it('exposes project and thread assignment IPC methods', () => {
    for (const method of ['projects.list', 'projects.save', 'projects.delete', 'threads.setProject']) {
      expect(ipcSource).toContain(`'${method}'`)
    }
    expect(ipcSource).toMatch(/'threads\.create':\s*\(modelId\?: string \| null, projectId\?: string \| null, runtimeId\?: string\)/)
  })

  it('exposes the artifact shape and complete artifact API', () => {
    expect(typesSource).toMatch(/export interface Artifact extends OutputFile/)
    for (const method of ['artifacts.list', 'artifacts.preview', 'artifacts.export', 'artifacts.saveAs', 'artifacts.reveal', 'artifacts.open']) {
      expect(ipcSource).toContain(`'${method}'`)
    }
    expect(ipcSource).toMatch(/'artifacts\.list':\s*\(projectId\?: string \| null\)/)
  })
})

describe('project/artifact implementation invariants', () => {
  it('keeps artifacts joined through threads and projects', () => {
    const candidates = ['src/main/outputs/outputs-service.ts', 'src/main/artifacts/artifacts-service.ts']
    const source = candidates
      .map((path) => {
        try {
          return readFileSync(path, 'utf8')
        } catch {
          return ''
        }
      })
      .join('\n')
    expect(source).toMatch(/outputs[\s\S]{0,300}threads|FROM outputs[\s\S]{0,300}JOIN threads/)
    expect(source).toMatch(/project_id|projectId/)
    expect(source).toMatch(/thread_title|threadTitle/)
  })
})
