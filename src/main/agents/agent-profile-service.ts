import type { AgentInfrastructure, AgentProfile, AgentProfileInput } from '@shared/types'
import { db, json } from '../core/db'
import { newId } from '../core/id'
import { emit } from '../core/ipc'
import { runtimeRegistry } from '../agent-runtime/registry'
import { models } from '../models/registry'
import { skills } from '../skills/skill-service'
import { mcp } from '../mcp/mcp-service'
import { connectors } from '../connectors/connector-service'
import { plugins } from '../plugins/plugin-service'
import { t } from '@shared/i18n'
import { agentTemplates, systemAgentDefaults, SYSTEM_AGENT_ID, type AgentTemplateId, type AgentTemplateTeamId } from '@shared/agent-templates'

interface Row {
  template_id: string | null
  id: string
  name: string
  description: string
  instructions: string
  runtime_id: string
  model_id: string | null
  infrastructure: string
  created_at: number
  updated_at: number
}

const emptyInfrastructure = (): AgentInfrastructure => ({ skillIds: [], mcpServerIds: [], connectorIds: [], pluginIds: [] })

function normalizeInfrastructure(value: AgentInfrastructure): AgentInfrastructure {
  if (!value || typeof value !== 'object') throw new Error(t('基础设施配置无效'))
  const ids = (items: unknown, label: string): string[] => {
    if (!Array.isArray(items) || items.length > 500 || items.some((id) => typeof id !== 'string' || !id || id.length > 500))
      throw new Error(t('{{v0}}绑定无效', { v0: label }))
    return [...new Set(items)]
  }
  return {
    skillIds: ids(value.skillIds, 'Skill'),
    mcpServerIds: ids(value.mcpServerIds, 'MCP'),
    connectorIds: ids(value.connectorIds, t('连接器')),
    pluginIds: ids(value.pluginIds, t('站点插件')),
  }
}

const toProfile = (row: Row): AgentProfile => ({
  id: row.id,
  templateId: row.template_id,
  name: row.name,
  description: row.description,
  instructions: row.instructions,
  runtimeId: row.runtime_id,
  modelId: row.model_id,
  infrastructure: json.parse<AgentInfrastructure>(row.infrastructure) ?? emptyInfrastructure(),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.id === SYSTEM_AGENT_ID && !row.name ? systemAgentDefaults() : {}),
})

class AgentProfileService {
  list(): AgentProfile[] {
    return (db().prepare('SELECT * FROM agents ORDER BY (id=?) DESC, updated_at DESC, name COLLATE NOCASE').all(SYSTEM_AGENT_ID) as Row[]).map(toProfile)
  }

  get(id: string): AgentProfile | null {
    const row = db().prepare('SELECT * FROM agents WHERE id=?').get(id) as Row | undefined
    return row ? toProfile(row) : null
  }

  save(input: AgentProfileInput): AgentProfile {
    const saved = this.persist(input, null)
    emit('agents.changed')
    return saved
  }

  addTemplate(templateId: AgentTemplateId): AgentProfile {
    const template = agentTemplates().find((item) => item.id === templateId)
    if (!template) throw new Error(t('智能体模板不存在'))
    const saved = this.installTemplate(template)
    emit('agents.changed')
    return saved
  }

  addTemplateTeam(teamId: AgentTemplateTeamId): void {
    const members = agentTemplates().filter((template) => template.team === teamId)
    if (!members.length) throw new Error(t('团队模板不存在'))
    db().transaction(() => {
      for (const template of members) this.installTemplate(template)
    })()
    emit('agents.changed')
  }

  private installTemplate(template: ReturnType<typeof agentTemplates>[number]): AgentProfile {
    const existing = db().prepare('SELECT * FROM agents WHERE template_id=?').get(template.id) as Row | undefined
    if (existing) return toProfile(existing)
    const availableConnectors = new Set(
      connectors
        .states()
        .filter((item) => item.connected && item.enabled && !item.error)
        .map((item) => item.id),
    )
    const availablePlugins = new Set(
      plugins
        .list()
        .filter((item) => item.enabled && !item.error)
        .map((item) => item.id),
    )
    const names = new Set(this.list().map((item) => item.name.toLowerCase()))
    let name = template.name
    for (let n = 2; names.has(name.toLowerCase()); n++) name = `${template.name} (${n})`
    return this.persist(
      {
        name,
        description: template.description,
        instructions: template.instructions,
        runtimeId: 'builtin',
        infrastructure: {
          skillIds: [],
          mcpServerIds: [],
          connectorIds: template.connectors.filter((id) => availableConnectors.has(id)),
          pluginIds: template.plugins.filter((id) => availablePlugins.has(id)),
        },
      },
      template.id,
    )
  }

  private persist(input: AgentProfileInput, templateId: AgentTemplateId | null): AgentProfile {
    if (!input || typeof input.name !== 'string') throw new Error(t('智能体名称必须是文本'))
    const name = input.name.trim()
    const description = (input.description ?? '').trim()
    const instructions = (input.instructions ?? '').trim()
    if (!name) throw new Error(t('智能体名称不能为空'))
    if (name.length > 120) throw new Error(t('智能体名称不能超过 120 个字符'))
    if (description.length > 1000) throw new Error(t('智能体描述不能超过 1000 个字符'))
    if (instructions.length > 20_000) throw new Error(t('智能体指令不能超过 20000 个字符'))
    const runtime = runtimeRegistry.info(input.runtimeId)
    if (!runtime.profile.enabled) throw new Error(t('运行时未启用'))
    const modelId = (runtime.capabilities.requiresNavoModel ?? runtime.capabilities.navoTools) ? (input.modelId ?? models.default()?.id ?? null) : null
    if (modelId && !models.get(modelId)) throw new Error(t('模型不存在'))
    if (modelId && !models.get(modelId)?.enabled) throw new Error(t('模型未启用'))
    const infrastructure = normalizeInfrastructure(input.infrastructure)
    const valid = {
      skillIds: () => skills.list(),
      mcpServerIds: () => mcp.list(),
      connectorIds: () => connectors.catalog(),
      pluginIds: () => plugins.list(),
    }
    for (const [key, values] of Object.entries(infrastructure) as [keyof AgentInfrastructure, string[]][]) {
      if (!values.length) continue
      const available = new Set(valid[key]().map((item) => item.id))
      const missing = values.find((id) => !available.has(id))
      if (missing) throw new Error(t('绑定的基础设施不存在：{{v0}}', { v0: missing }))
    }
    const id = input.id ?? newId()
    const existing = input.id ? this.get(id) : null
    if (input.id && !existing) throw new Error(t('智能体不存在'))
    const duplicate = db().prepare('SELECT id FROM agents WHERE name=? COLLATE NOCASE AND id!=?').get(name, id) as { id: string } | undefined
    if (duplicate) throw new Error(t('智能体名称已存在'))
    const now = Date.now()
    db()
      .prepare(
        `INSERT INTO agents(id,name,description,instructions,runtime_id,model_id,infrastructure,created_at,updated_at,template_id)
         VALUES(?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name,description=excluded.description,instructions=excluded.instructions,
           runtime_id=excluded.runtime_id,model_id=excluded.model_id,infrastructure=excluded.infrastructure,updated_at=excluded.updated_at`,
      )
      .run(id, name, description, instructions, runtime.profile.id, modelId, JSON.stringify(infrastructure), existing?.createdAt ?? now, now, templateId)
    return this.get(id)!
  }

  delete(id: string): void {
    if (id === SYSTEM_AGENT_ID) throw new Error(t('系统内置智能体需要保留'))
    db().prepare('DELETE FROM agents WHERE id=?').run(id)
    emit('agents.changed')
  }

  /** Existing conversations use their creation-time snapshot even after a profile is edited or deleted. */
  snapshot(id: string): AgentProfile {
    const profile = this.get(id)
    if (!profile) throw new Error(t('智能体不存在'))
    if (profile.modelId === null && runtimeRegistry.info(profile.runtimeId).capabilities.requiresNavoModel) {
      const model = models.default()
      if (!model) throw new Error(t('没有已启用的模型，请在「模型」页面启用一个模型'))
      profile.modelId = model.id
    }
    return profile
  }

  forThread(threadId: string): AgentProfile | null {
    const row = db().prepare('SELECT agent_config FROM threads WHERE id=?').get(threadId) as { agent_config: string | null } | undefined
    return json.parse<AgentProfile>(row?.agent_config) ?? null
  }
}

export const agentProfiles = new AgentProfileService()
