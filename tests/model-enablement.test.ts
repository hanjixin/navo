import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
const state = vi.hoisted(() => ({ db: null as unknown as DatabaseSync }))
vi.mock('../src/main/core/db', () => ({
  db: () => ({
    prepare: (sql: string) => {
      const statement = state.db.prepare(sql)
      statement.setAllowBareNamedParameters(true)
      return statement
    },
    transaction: (fn: () => unknown) => () => {
      state.db.exec('SAVEPOINT model_transaction')
      try {
        const result = fn()
        state.db.exec('RELEASE model_transaction')
        return result
      } catch (error) {
        state.db.exec('ROLLBACK TO model_transaction; RELEASE model_transaction')
        throw error
      }
    },
  }),
  json: { parse: (value: string | null) => (value ? JSON.parse(value) : null), str: (value: unknown) => (value == null ? null : JSON.stringify(value)) },
}))
vi.mock('../src/main/core/secrets', () => ({ secrets: { has: () => false, get: () => null, set: vi.fn(), delete: vi.fn() } }))
vi.mock('../src/main/core/ipc', () => ({ emit: vi.fn() }))
vi.mock('../src/main/models/factory', () => ({ buildChatModel: () => ({ invoke: async () => ({ content: 'pong' }) }) }))
import { models, providers, resolveModel, testModel } from '../src/main/models/registry'
const migrations = Array.from(
  readFileSync('src/main/core/db-core.ts', 'utf8')
    .split('/** Opens')[0]
    .matchAll(/`([\s\S]*?)`/g),
  (m) => m[1],
)
let providerId: string
const create = (model: string, enabled?: boolean) => models.save({ providerId, model, displayName: model, supportsTools: true, supportsVision: false, enabled })
beforeEach(() => {
  state.db = new DatabaseSync(':memory:')
  state.db.exec('PRAGMA foreign_keys=ON')
  migrations.forEach((sql) => state.db.exec(sql))
  providerId = providers.save({ name: 'Provider', type: 'openai-compatible' }).id
})
afterEach(() => {
  state.db.close()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('upgrades existing models as enabled without changing their selected default', () => {
  state.db.close()
  state.db = new DatabaseSync(':memory:')
  migrations.slice(0, -1).forEach((sql) => state.db.exec(sql))
  state.db.exec(
    "INSERT INTO providers(id,type,name,created_at) VALUES('p','openai','P',1); INSERT INTO models(id,provider_id,model,display_name,is_default) VALUES('old','p','old','Old',1)",
  )
  state.db.exec(migrations.at(-1)!)
  expect(models.get('old')).toMatchObject({ enabled: true, isDefault: true })
})
it('imports unique remote models disabled and preserves existing enabled, edited, and default settings', async () => {
  const old = create('old')
  vi.spyOn(providers, 'fetchModels').mockResolvedValue(['old', 'new', 'new', '  third  '])
  expect(await providers.importModels(providerId)).toEqual({ imported: 2, existing: 1, total: 3 })
  expect(models.get(old.id)).toEqual(old)
  expect(
    models
      .list()
      .filter((model) => model.id !== old.id)
      .every((model) => !model.enabled && !model.isDefault),
  ).toBe(true)
  expect(await providers.importModels(providerId)).toEqual({ imported: 0, existing: 3, total: 3 })
  expect(models.list()).toHaveLength(3)
})
it('leaves no partial import when an insert fails', async () => {
  vi.spyOn(providers, 'fetchModels').mockResolvedValue(['good', 'bad'])
  state.db.exec("CREATE TRIGGER fail_model BEFORE INSERT ON models WHEN NEW.model='bad' BEGIN SELECT RAISE(ABORT,'failed'); END")
  await expect(providers.importModels(providerId)).rejects.toThrow('failed')
  expect(models.list()).toEqual([])
})
it('falls back to an enabled default and rejects explicitly disabled or removed model references', () => {
  const a = create('A'),
    b = create('B')
  models.setEnabled(a.id, false)
  expect(models.default()?.id).toBe(b.id)
  expect(models.get(a.id)?.isDefault).toBe(false)
  expect(() => resolveModel(a.id)).toThrow('停用')
  expect(() => models.setDefault(a.id)).toThrow('启用')
  expect(() => resolveModel('missing')).toThrow('不存在')
  models.setEnabled(b.id, false)
  expect(models.default()).toBeNull()
  expect(() => resolveModel()).toThrow('没有已启用')
  models.setEnabled(a.id, true)
  expect(models.default()?.id).toBe(a.id)
  models.delete(a.id)
  expect(models.default()).toBeNull()
})
it('preserves disabled state on legacy edits and allows connection testing without enabling', async () => {
  const model = create('Disabled', false)
  const { enabled: _enabled, ...input } = model
  expect(models.save(input).enabled).toBe(false)
  expect((await testModel(model.id)).ok).toBe(true)
  expect(models.get(model.id)?.enabled).toBe(false)
  expect(create('Manual').enabled).toBe(true)
})
it('does not change the config snapshot already supplied to a running agent', () => {
  const model = create('Running')
  const snapshot = resolveModel(model.id)
  models.setEnabled(model.id, false)
  expect(snapshot.model).toBe('Running')
  expect(() => resolveModel(model.id)).toThrow('停用')
})

it('imports every page returned by a paginated provider', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'first' }], has_more: true, last_id: 'first' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'second' }], has_more: false }) })
  vi.stubGlobal('fetch', fetchMock)
  expect(await providers.importModels(providerId)).toEqual({ imported: 2, existing: 0, total: 2 })
  expect(fetchMock.mock.calls[1][0]).toContain('after_id=first')
  expect(models.list().every((model) => !model.enabled)).toBe(true)
  expect(models.default()).toBeNull()
})

it('preserves disabled customized entries and scopes deduplication to each provider', async () => {
  const disabled = models.save({
    providerId,
    model: 'same',
    displayName: 'Custom label',
    supportsTools: false,
    supportsVision: true,
    enabled: false,
    temperature: 0.2,
  })
  const other = providers.save({ name: 'Other', type: 'openai-compatible' })
  vi.spyOn(providers, 'fetchModels').mockResolvedValue(['same'])
  expect(await providers.importModels(providerId)).toEqual({ imported: 0, existing: 1, total: 1 })
  expect(models.get(disabled.id)).toEqual(disabled)
  expect(await providers.importModels(other.id)).toEqual({ imported: 1, existing: 0, total: 1 })
  expect(models.list()).toHaveLength(2)
})

it('manual configuration reuses an imported model and preserves its pricing', async () => {
  vi.spyOn(providers, 'fetchModels').mockResolvedValue(['imported'])
  await providers.importModels(providerId)
  const imported = models.list()[0]
  models.setPricing(imported.id, { input: 1, output: 2, currency: 'USD' })
  const configured = models.save({ providerId, model: 'imported', displayName: 'My model', supportsTools: true, supportsVision: true, enabled: true })
  expect(configured).toMatchObject({
    id: imported.id,
    displayName: 'My model',
    enabled: true,
    supportsVision: true,
    pricing: { input: 1, output: 2, currency: 'USD' },
  })
  expect(models.list()).toHaveLength(1)
  expect(models.default()?.id).toBe(imported.id)
})
it('rejects editing into another model in the same provider without modifying either row', () => {
  const a = create('A'),
    b = create('B')
  expect(() => models.save({ ...a, model: b.model })).toThrow('已存在此模型')
  expect(models.get(a.id)).toEqual(a)
  expect(models.get(b.id)).toEqual(b)
  const other = providers.save({ name: 'Other', type: 'openai-compatible' })
  const independent = models.save({ providerId: other.id, model: a.model, displayName: 'Other A', supportsTools: true, supportsVision: false })
  expect(independent.id).not.toBe(a.id)
  expect(models.list()).toHaveLength(3)
})
