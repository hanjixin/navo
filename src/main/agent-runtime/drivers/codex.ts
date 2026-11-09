import type { RunResult, UsageEvent } from '../contracts'
import type { ExternalRuntimeContext, ExternalRuntimeDriver } from '../types'
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
    navoTools: false,
    nativeTools: true,
    approvals: false,
    images: false,
    resume: true,
    fork: false,
    tokenStreaming: true,
  }

  async run(context: ExternalRuntimeContext): Promise<RunResult> {
    const { request, profile, signal } = context
    if (signal.aborted) return { finalText: '', interrupted: false, aborted: true }
    if (request.input.kind !== 'message') throw new Error('Codex runtime does not support approval resume')
    if (request.input.images.length) throw new Error('Codex runtime does not support images')
    validateCodexArgs(profile.args)
    let finalText = ''
    let completed = false
    let threadId = ''
    let lastUsage: UsageEvent | undefined
    let complete!: (value: RunResult) => void
    const result = new Promise<RunResult>((resolve) => {
      complete = resolve
    })
    let child: JsonLineProcess | undefined
    const streamed = new Map<string, string>()
    const idFor = (id: unknown): string => `${request.runId}:codex:${String(id ?? 'assistant')}`
    try {
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
        ],
        cwd: request.paths.workspace,
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
          if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
            const messageId = idFor(params.itemId)
            streamed.set(messageId, (streamed.get(messageId) ?? '') + params.delta)
            context.emit({ type: 'token', threadId: request.threadId, messageId, text: params.delta })
          }
          if (method === 'item/completed' || method === 'item/started') {
            const item = record(params.item)
            const itemId = idFor(item.id)
            if (item.type === 'agentMessage' && method === 'item/completed' && typeof item.text === 'string') {
              finalText = item.text
              context.emit({ type: 'message', threadId: request.threadId, message: { id: itemId, role: 'assistant', content: item.text } })
            }
            if (['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch'].includes(String(item.type))) {
              if (method === 'item/started') {
                context.emit({
                  type: 'message',
                  threadId: request.threadId,
                  message: {
                    id: `${itemId}:call`,
                    role: 'assistant',
                    content: '',
                    toolCalls: [{ id: itemId, name: `codex.${String(item.type)}`, args: item }],
                  },
                })
              } else {
                context.emit({
                  type: 'message',
                  threadId: request.threadId,
                  message: {
                    id: `${itemId}:result`,
                    role: 'tool',
                    toolCallId: itemId,
                    toolName: `codex.${String(item.type)}`,
                    content: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : JSON.stringify(item),
                    status: item.status === 'failed' || item.status === 'declined' ? 'error' : 'success',
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
            completed = true
            const turn = record(params.turn)
            const status = turn.status
            if (status === 'completed') complete({ finalText, interrupted: false })
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
      const common = {
        cwd: request.paths.workspace,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        ...(profile.model ? { model: profile.model } : {}),
        ...(profile.provider ? { modelProvider: profile.provider } : {}),
        developerInstructions: request.systemPrompt,
      }
      const response = await child.request({
        method: context.session?.threadId ? 'thread/resume' : 'thread/start',
        params: { ...common, ...(context.session?.threadId ? { threadId: context.session.threadId } : {}) },
      })
      const nativeThread = record(record(response.result).thread)
      if (typeof nativeThread.id !== 'string' || !nativeThread.id) throw new Error('Codex did not return a thread ID')
      threadId = nativeThread.id
      context.saveSession({ threadId })
      await child.request({
        method: 'turn/start',
        params: {
          threadId,
          cwd: request.paths.workspace,
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'readOnly', networkAccess: false },
          input: [{ type: 'text', text: [request.input.text, request.input.context].filter(Boolean).join('\n\n'), text_elements: [] }],
        },
      })
      return await Promise.race([result, child.failure])
    } catch (error) {
      finalText ||= [...streamed.values()].join('\n')
      if (signal.aborted) return { finalText, interrupted: false, aborted: true }
      throw error
    } finally {
      if (lastUsage) context.usage(lastUsage)
      await child?.stop()
    }
  }
}
