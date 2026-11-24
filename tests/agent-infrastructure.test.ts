import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('applies agent infrastructure allow-lists at every runtime boundary', () => {
  const toolRegistry = readFileSync('src/main/agent/tool-registry.ts', 'utf8')
  expect(toolRegistry).toContain('plugins.tools(ctx.tab, infrastructure?.pluginIds)')
  expect(toolRegistry).toContain('mcp.tools(ctx.projectId, infrastructure?.mcpServerIds)')
  expect(toolRegistry).toContain('connectors.tools(infrastructure?.connectorIds)')

  const agentService = readFileSync('src/main/agent/agent-service.ts', 'utf8')
  expect(agentService).toContain('skills.localAllowed(bound?.skillIds)')
  expect(agentService).toContain('skills.mounts(thread.projectId, bound?.skillIds)')

  const runner = readFileSync('src/main/agent-host/runner.ts', 'utf8')
  expect(runner).toContain("req.localSkills.length ? ['/skills/'] : []")
})
