import { randomUUID } from 'node:crypto'
import type { ToolCall } from '@shared/types'
import type { RunResult, UsageEvent } from '../contracts'
import type { ExternalRuntimeContext, ExternalRuntimeDriver } from '../types'
import { createRuntimeMcpBridge } from '../mcp-tool-bridge'
import { normalizeRuntimeText, RuntimeTextStream } from '../message-normalizer'
import { JsonLineProcess, record } from '../process'

const reservedCodexFlags = new Set([
  '-c',
  '--config',
  '--enable',
  '--disable',
  '--profile',
  '-p',
  '--model',
  '-m',
  '--sandbox',
  '-s',
  '--ask-for-approval',
  '-a',
  '--approve-for-me',
  '--full-auto',
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
  '--yolo',
  '--cd',
  '-C',
  '--add-dir',
  '--worktree',
  '--remote',
  '--remote-auth-token-env',
  '--listen',
  '--stdio',
  '--code-mode-host',
  '--oss',
  '--local-provider',
])

export function validateCodexArgs(args: string[]): void {
  for (const argument of args) {
    const flag = argument.split('=', 1)[0]
    if (argument === '--' || reservedCodexFlags.has(flag) || /^-[cpmsaC].+/.test(argument)) {
      throw new Error(`Codex runtime argument is managed by Navo: ${flag}`)
    }
  }
}

/** Owns a dedicated app-server process, never the user's desktop daemon. */
export class CodexRuntimeDriver implements ExternalRuntimeDriver {
  readonly kind = 'codex' as const
  readonly capabilities = {
    navoTools: true,
    nativeTools: true,
    approvals: true,
    images: true,
    resume: true,
    fork: false,
    tokenStreaming: true,
    requiresNavoModel: false,
    workspaceTools: true,
  }

  async run(context: ExternalRuntimeContext): Promise<RunResult> {
    const { request, profile, signal } = context
    if (signal.aborted) return { finalText: '', interrupted: false, aborted: true }
    if (request.input.kind !== 'message') throw new Error('Codex runtime does not support approval resume')
    if (request.tools.length && !context.tools) throw new Error('Codex requires a Navo tool bridge for this run')
    validateCodexArgs(profile.args)
    let finalText = ''
    let completed = false
    let threadId = ''
    let turnId = ''
    let markupWarning = false
    let lastUsage: UsageEvent | undefined
    let complete!: (value: RunResult) => void
    const result = new Promise<RunResult>((resolve) => {
      complete = resolve
    })
    let child: JsonLineProcess | undefined
    let bridge: Awaited<ReturnType<typeof createRuntimeMcpBridge>> | undefined
    const bridgeName = `navo_${randomUUID().replaceAll('-', '')}`
    const streams = new Map<string, RuntimeTextStream>()
    const finalized = new Set<string>()
    const nativeCalls = new Map<string, ToolCall>()
    const nativeResults = new Set<string>()
    const idFor = (id: unknown): string => `${request.runId}:codex:${String(id ?? 'assistant')}`
    const toolName = (type: unknown): string => {
      switch (String(type)) {
        case 'commandExecution':
          return 'codex_run_command'
        case 'fileChange':
          return 'codex_file_change'
        case 'mcpToolCall':
          return 'codex_mcp_tool'
        case 'dynamicToolCall':
          return 'codex_dynamic_tool'
        case 'webSearch':
          return 'codex_web_search'
        default:
          return 'codex_tool'
      }
    }
    const toolArgs = (type: unknown, item: Record<string, unknown>): Record<string, unknown> => {
      if (type === 'commandExecution') return { command: item.command ?? item.commandLine ?? '', cwd: item.cwd ?? request.paths.workspace }
      if (type === 'fileChange') return { changes: item.changes ?? item.patch ?? item.fileChanges ?? '' }
      if (type === 'mcpToolCall')
        return { server: item.server ?? item.serverName ?? '', tool: item.tool ?? item.name ?? '', args: item.arguments ?? item.input ?? {} }
      if (type === 'webSearch') return { query: item.query ?? item.searchQuery ?? '' }
      return item
    }
    const publishText = (messageId: string, text: string) => {
      if (finalized.has(messageId)) return
      const normalized = normalizeRuntimeText(text)
      markupWarning ||= normalized.diagnostics.length > 0
      finalized.add(messageId)
      finalText = normalized.text
      context.emit({
        type: 'message',
        threadId: request.threadId,
        message: {
          id: messageId,
          role: 'assistant',
          content: normalized.text,
          ...(normalized.diagnostics.length ? { runtimeWarning: 'unexecuted_tool_markup' as const } : {}),
        },
      })
    }
    const finishStreams = () => {
      for (const [messageId, stream] of streams) {
        if (finalized.has(messageId)) continue
        const normalized = stream.finish()
        markupWarning ||= normalized.diagnostics.length > 0
        finalized.add(messageId)
        finalText = normalized.text
        context.emit({
          type: 'message',
          threadId: request.threadId,
          message: {
            id: messageId,
            role: 'assistant',
            content: normalized.text,
            ...(normalized.diagnostics.length ? { runtimeWarning: 'unexecuted_tool_markup' as const } : {}),
          },
        })
      }
    }
    const nativeState = (item: Record<string, unknown>, done: boolean): NonNullable<ToolCall['activity']>['status'] => {
      if (!done) return 'running'
      if (item.status === 'interrupted' || item.status === 'cancelled') return 'cancelled'
      if (item.status === 'failed' || item.status === 'declined' || (typeof item.exitCode === 'number' && item.exitCode !== 0) || item.error != null)
        return 'error'
      return 'success'
    }
    const nativeActivity = (item: Record<string, unknown>, done: boolean): NonNullable<ToolCall['activity']> => {
      const status = nativeState(item, done)
      if (item.type === 'commandExecution')
        return { kind: 'command', status, command: String(item.command ?? item.commandLine ?? ''), cwd: String(item.cwd ?? request.paths.workspace) }
      if (item.type === 'fileChange')
        return {
          kind: 'file_change',
          status,
          paths: Array.isArray(item.changes)
            ? item.changes.map((change) => record(change).path).filter((path): path is string => typeof path === 'string')
            : [],
        }
      return { kind: item.type === 'webSearch' ? 'search' : 'tool', status }
    }
    const finishNativeCalls = (aborted: boolean) => {
      for (const [id, call] of nativeCalls) {
        if (nativeResults.has(id)) continue
        nativeResults.add(id)
        const updated = { ...call, activity: { ...call.activity!, status: aborted ? ('cancelled' as const) : ('error' as const) } }
        context.emit({ type: 'message', threadId: request.threadId, message: { id: `${id}:call`, role: 'assistant', content: '', toolCalls: [updated] } })
        context.emit({
          type: 'message',
          threadId: request.threadId,
          message: {
            id: `${id}:result`,
            role: 'tool',
            toolCallId: id,
            toolName: call.name,
            status: 'error',
            content: 'The runtime stopped before this tool reported its final outcome.',
            runtimeWarning: 'tool_outcome_unknown',
          },
        })
      }
    }
    try {
      if (context.tools && request.tools.length) bridge = await createRuntimeMcpBridge({ tools: request.tools, dispatcher: context.tools, signal })
      child = new JsonLineProcess({
        command: profile.command,
        args: [
          ...profile.args,
          'app-server',
          '--listen',
          'stdio://',
          '-c',
          'mcp_servers={}',
          '-c',
          'features.hooks=false',
          '-c',
          'features.plugins=false',
          '-c',
          'features.apps=false',
          '-c',
          'features.browser_use=false',
          '-c',
          'features.computer_use=false',
          '-c',
          'features.multi_agent=false',
          '-c',
          'features.memories=false',
          '-c',
          'features.external_agent_memory_import=false',
          '-c',
          'features.skill_mcp_dependency_install=false',
        ],
        cwd: request.paths.workspace,
        // Keep the capability token out of arguments, config snapshots and persisted session data.
        env: bridge ? { NAVO_RUNTIME_MCP_AUTHORIZATION: `Bearer ${bridge.token}` } : undefined,
        signal,
        onMessage: (message) => {
          if (completed) return
          const method = String(message.method ?? '')
          const params = record(message.params)
          if (message.id != null && method) {
            // Do not grant native privileges or silently answer questions on the user's behalf.
            if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
              child?.send({ id: message.id, result: { decision: 'decline' } })
            } else if (method === 'item/permissions/requestApproval') {
              child?.send({ id: message.id, result: { permissions: {}, scope: 'turn' } })
            } else {
              child?.send({ id: message.id, error: { code: -32601, message: 'Native approvals and interactive requests are not supported by this adapter' } })
            }
            throw new Error(`Codex requested unsupported native interaction: ${method}`)
          }
          if (typeof params.threadId === 'string' && threadId && params.threadId !== threadId) return
          if (typeof params.turnId === 'string' && turnId && params.turnId !== turnId) return
          if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
            const messageId = idFor(params.itemId)
            if (finalized.has(messageId)) return
            let stream = streams.get(messageId)
            if (!stream) streams.set(messageId, (stream = new RuntimeTextStream()))
            const text = stream.push(params.delta)
            if (text) context.emit({ type: 'token', threadId: request.threadId, messageId, text })
          }
          if (method === 'item/completed' || method === 'item/started') {
            const item = record(params.item)
            const itemId = idFor(item.id)
            if (item.type === 'agentMessage' && method === 'item/completed' && typeof item.text === 'string') {
              publishText(itemId, item.text)
            }
            if (['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch'].includes(String(item.type))) {
              // Navo MCP calls are emitted by the authenticated run dispatcher, including approval state.
              if (bridge && item.type === 'mcpToolCall' && (item.server === bridgeName || item.serverName === bridgeName)) return
              const done = method === 'item/completed'
              if (nativeResults.has(itemId) || (!done && nativeCalls.has(itemId))) return
              const mergedItem = { ...nativeCalls.get(itemId)?.args, ...item }
              const call: ToolCall = {
                id: itemId,
                name: toolName(item.type),
                args: toolArgs(item.type, mergedItem),
                activity: nativeActivity(mergedItem, done),
              }
              nativeCalls.set(itemId, call)
              context.emit({
                type: 'message',
                threadId: request.threadId,
                message: { id: `${itemId}:call`, role: 'assistant', content: '', toolCalls: [call] },
              })
              if (done) {
                nativeResults.add(itemId)
                context.emit({
                  type: 'message',
                  threadId: request.threadId,
                  message: {
                    id: `${itemId}:result`,
                    role: 'tool',
                    toolCallId: itemId,
                    toolName: toolName(item.type),
                    content:
                      typeof item.aggregatedOutput === 'string'
                        ? item.aggregatedOutput
                        : JSON.stringify(item.result ?? item.changes ?? item.error ?? toolArgs(item.type, item)),
                    status: call.activity?.status === 'success' ? 'success' : 'error',
                  },
                })
              }
            }
          }
          if (method === 'thread/tokenUsage/updated') {
            const usage = record(record(params.tokenUsage).last)
            const count = (key: string): number => (typeof usage[key] === 'number' && Number.isFinite(usage[key]) ? Math.max(0, usage[key] as number) : 0)
            lastUsage = {
              threadId: request.threadId,
              model: profile.model ?? 'codex',
              usage: { input: count('inputTokens'), output: count('outputTokens'), cached: count('cachedInputTokens') },
            }
          }
          if (method === 'turn/completed') {
            const turn = record(params.turn)
            if (turnId && typeof turn.id === 'string' && turn.id !== turnId) return
            finishStreams()
            finishNativeCalls(turn.status === 'interrupted')
            completed = true
            const status = turn.status
            if (status === 'completed')
              complete({
                finalText,
                interrupted: false,
                ...(markupWarning
                  ? { error: 'The model returned tool-call markup as text; no tool was executed from that text. Check provider compatibility.' }
                  : {}),
              })
            else if (status === 'interrupted') complete({ finalText, interrupted: false, aborted: true })
            else complete({ finalText, interrupted: false, error: String(record(turn.error).message ?? 'Codex turn failed') })
          }
        },
      })
      await child.request({
        method: 'initialize',
        params: {
          clientInfo: { name: 'navo', title: 'Navo', version: request.meta.appVersion },
          capabilities: { experimentalApi: false },
        },
      })
      child.send({ method: 'initialized', params: {} })
      // Codex deep-merges config tables: mcp_servers={} alone does NOT remove user servers.
      // Enumerate names without retaining or logging the merged config, then disable every inherited server.
      const inheritedServers = await child
        .request({ method: 'config/read', params: { includeLayers: false, cwd: request.paths.workspace } })
        .then((response) => {
          const config = record(response.result).config
          if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Codex did not provide a valid configuration for MCP isolation')
          return Object.keys(record(record(config).mcp_servers))
        })
      const mcpServers: Record<string, Record<string, unknown>> = Object.fromEntries(inheritedServers.map((name) => [name, { enabled: false }]))
      if (bridge)
        mcpServers[bridgeName] = {
          enabled: true,
          url: bridge.url,
          env_http_headers: { Authorization: 'NAVO_RUNTIME_MCP_AUTHORIZATION' },
          tool_timeout_sec: 86400,
          // Only the run-scoped Navo tools bypass Codex's native MCP prompt. Navo's
          // dispatcher still performs its own approval before the real operation.
          // `auto` is insufficient here: unknown/write annotations require approval
          // and would be rejected by the deliberately unchanged native `never` policy.
          enabled_tools: [...new Set(request.tools.map((tool) => tool.name))],
          default_tools_approval_mode: 'prompt',
          tools: Object.fromEntries(request.tools.map((tool) => [tool.name, { approval_mode: 'approve' }])),
        }
      const common = {
        cwd: request.paths.workspace,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ...(profile.model ? { model: profile.model } : {}),
        ...(profile.provider ? { modelProvider: profile.provider } : {}),
        developerInstructions: request.systemPrompt,
        config: { mcp_servers: mcpServers },
      }
      const response = await child.request({
        method: context.session?.threadId ? 'thread/resume' : 'thread/start',
        params: { ...common, ...(context.session?.threadId ? { threadId: context.session.threadId } : {}) },
      })
      const nativeThread = record(record(response.result).thread)
      if (typeof nativeThread.id !== 'string' || !nativeThread.id) throw new Error('Codex did not return a thread ID')
      threadId = nativeThread.id
      context.saveSession({ threadId })
      await child.request(
        {
          method: 'turn/start',
          params: {
            threadId,
            cwd: request.paths.workspace,
            approvalPolicy: 'never',
            sandboxPolicy: { type: 'readOnly', networkAccess: false },
            input: [
              { type: 'text', text: [request.input.text, request.input.context].filter(Boolean).join('\n\n'), text_elements: [] },
              ...request.input.images.map((image_url) => ({ type: 'image', image_url })),
            ],
          },
        },
        {
          onResponse: (response) => {
            const turn = record(record(response.result).turn)
            if (typeof turn.id === 'string') turnId = turn.id
          },
        },
      )
      return await Promise.race([result, child.failure])
    } catch (error) {
      finalText ||= [...streams.values()].map((stream) => stream.finish().text).join('\n')
      finishNativeCalls(signal.aborted)
      if (signal.aborted) return { finalText, interrupted: false, aborted: true }
      throw error
    } finally {
      if (lastUsage) context.usage(lastUsage)
      await child?.stop()
      await bridge?.close()
    }
  }
}
