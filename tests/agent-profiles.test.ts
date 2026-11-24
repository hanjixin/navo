import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import type Database from 'better-sqlite3'

const state = vi.hoisted(() => ({
  database: null as unknown as Database.Database,
  defaultModel: 'model' as string | null,
  runtimeEnabled: true,
  modelEnabled: true,
}))
vi.mock('../src/main/core/db', () => ({
  db: () => state.database,
  json: {
    parse: (value: string | null | undefined) => (value ? JSON.parse(value) : null),
    str: (value: unknown) => (value == null ? null : JSON.stringify(value)),
  },
}))
vi.mock('../src/main/core/ipc', () => ({ emit: vi.fn() }))
vi.mock('../src/main/agent-runtime/registry', () => ({
  runtimeRegistry: {
    info: (id: string) => {
      if (!['builtin', 'codex'].includes(id)) throw new Error('Unknown agent runtime')
      return {
        profile: { id, kind: id, name: id, enabled: state.runtimeEnabled, command: '', args: [] },
        capabilities: { navoTools: id === 'builtin', requiresNavoModel: id === 'builtin' },
      }
    },
  },
}))
vi.mock('../src/main/models/registry', () => ({
  models: {
    get: (id: string) => (id === 'model' ? { id, enabled: state.modelEnabled } : null),
    default: () => (state.defaultModel ? { id: state.defaultModel, enabled: state.modelEnabled } : null),
  },
}))
vi.mock('../src/main/skills/skill-service', () => ({ skills: { list: () => [{ id: 'skill' }] } }))
vi.mock('../src/main/mcp/mcp-service', () => ({ mcp: { list: () => [{ id: 'mcp' }] } }))
vi.mock('../src/main/connectors/connector-service', () => ({
  connectors: {
    catalog: () => [{ id: 'connector' }, { id: 'github' }, { id: 'linear' }],
    states: () => [
      { id: 'github', connected: true, enabled: true },
      { id: 'linear', connected: true, enabled: false },
    ],
  },
}))
vi.mock('../src/main/plugins/plugin-service', () => ({ plugins: { list: () => [{ id: 'plugin' }] } }))

import { agentProfiles } from '../src/main/agents/agent-profile-service'
import { SYSTEM_AGENT_ID } from '../src/shared/agent-templates'

beforeEach(() => {
  state.defaultModel = 'model'
  state.runtimeEnabled = true
  state.modelEnabled = true
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys=ON')
  const source = readFileSync('src/main/core/db-core.ts', 'utf8').split('/** Opens')[0]
  for (const migration of source.matchAll(/`([\s\S]*?)`/g)) sqlite.exec(migration[1])
  state.database = sqlite as unknown as Database.Database
})

afterEach(() => {
  ;(state.database as unknown as DatabaseSync).close()
  vi.restoreAllMocks()
})

describe('agent profiles', () => {
  it('persists normalized bindings and keeps creation time while editing', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100)
    const created = agentProfiles.save({
      name: '  Engineering  ',
      description: '  Builds things  ',
      instructions: '  Be precise  ',
      runtimeId: 'builtin',
      infrastructure: { skillIds: ['skill', 'skill'], mcpServerIds: ['mcp'], connectorIds: ['connector'], pluginIds: ['plugin'] },
    })
    expect(created).toMatchObject({
      name: 'Engineering',
      description: 'Builds things',
      instructions: 'Be precise',
      modelId: 'model',
      createdAt: 100,
      infrastructure: { skillIds: ['skill'], mcpServerIds: ['mcp'], connectorIds: ['connector'], pluginIds: ['plugin'] },
    })
    vi.mocked(Date.now).mockReturnValue(200)
    const edited = agentProfiles.save({ ...created, name: 'Edited' })
    expect(edited).toMatchObject({ name: 'Edited', createdAt: 100, updatedAt: 200 })
    expect(agentProfiles.list()).toEqual([agentProfiles.get(SYSTEM_AGENT_ID), edited])
  })

  it('rejects missing infrastructure and duplicate names without partial writes', () => {
    const base = { runtimeId: 'builtin', infrastructure: { skillIds: [], mcpServerIds: [], connectorIds: [], pluginIds: [] } }
    agentProfiles.save({ ...base, name: 'One' })
    expect(() => agentProfiles.save({ ...base, name: 'one' })).toThrow('智能体名称已存在')
    expect(() => agentProfiles.save({ ...base, name: 'Missing', infrastructure: { ...base.infrastructure, skillIds: ['gone'] } })).toThrow(
      '绑定的基础设施不存在',
    )
    expect(agentProfiles.list()).toHaveLength(2)
  })

  it('rejects disabled runtimes and models with actionable errors', () => {
    const base = { runtimeId: 'builtin', infrastructure: { skillIds: [], mcpServerIds: [], connectorIds: [], pluginIds: [] } }
    state.runtimeEnabled = false
    expect(() => agentProfiles.save({ ...base, name: 'Disabled runtime' })).toThrow('运行时未启用')
    state.runtimeEnabled = true
    state.modelEnabled = false
    expect(() => agentProfiles.save({ ...base, name: 'Disabled model' })).toThrow('模型未启用')
    expect(agentProfiles.list().map((agent) => agent.id)).toEqual([SYSTEM_AGENT_ID])
  })

  it('starts with one editable permanent assistant and captures the default model at launch', () => {
    expect(agentProfiles.list().map((agent) => agent.id)).toEqual([SYSTEM_AGENT_ID])
    expect(() => agentProfiles.delete(SYSTEM_AGENT_ID)).toThrow()
    expect(agentProfiles.snapshot(SYSTEM_AGENT_ID)).toMatchObject({ id: SYSTEM_AGENT_ID, name: 'Navo 助手', modelId: 'model' })
    expect(agentProfiles.get(SYSTEM_AGENT_ID)?.modelId).toBeNull()
    expect(agentProfiles.save({ ...agentProfiles.get(SYSTEM_AGENT_ID)!, instructions: 'My instructions' }).instructions).toBe('My instructions')
  })

  it('installs a template once, keeps edits, and only binds available recommended resources', () => {
    state.defaultModel = null
    const installed = agentProfiles.addTemplate('engineering-update')
    expect(installed).toMatchObject({ templateId: 'engineering-update', modelId: null, infrastructure: { connectorIds: ['github'] } })
    expect(() => agentProfiles.snapshot(installed.id)).toThrow('没有已启用的模型')
    const edited = agentProfiles.save({ ...installed, instructions: 'Custom', infrastructure: { ...installed.infrastructure, connectorIds: [] } })
    expect(agentProfiles.addTemplate('engineering-update')).toEqual(edited)
    state.defaultModel = 'model'
    expect(agentProfiles.snapshot(edited.id).modelId).toBe('model')
    agentProfiles.delete(edited.id)
    expect(agentProfiles.addTemplate('engineering-update').id).not.toBe(installed.id)
    expect(() => agentProfiles.addTemplate('unknown' as never)).toThrow()
  })

  it('preserves a conversation snapshot after the reusable profile is deleted', () => {
    const profile = agentProfiles.save({
      name: 'Snapshot',
      runtimeId: 'codex',
      infrastructure: { skillIds: [], mcpServerIds: [], connectorIds: [], pluginIds: [] },
    })
    state.database
      .prepare('INSERT INTO threads(id,title,model_id,created_at,updated_at,agent_id,agent_config) VALUES(?,?,?,?,?,?,?)')
      .run('thread', 'Snapshot', null, 1, 1, profile.id, JSON.stringify(profile))
    agentProfiles.delete(profile.id)
    expect(agentProfiles.get(profile.id)).toBeNull()
    expect(state.database.prepare('SELECT agent_id FROM threads WHERE id=?').get('thread')).toMatchObject({ agent_id: null })
    expect(agentProfiles.forThread('thread')).toEqual(profile)
  })
})
