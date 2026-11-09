import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { JsonLineProcess, record } from '../process'
import type { ExternalRuntimeContext, ExternalRuntimeDriver } from '../types'
import type { RunResult } from '../contracts'

export function validateDshArgs(args: string[]): void {
  if (args.some((arg) => arg === '--' || /^--(?:profile|patch)(?:=|$)/.test(arg)))
    throw new Error('DSH runtime arguments cannot override the managed SDK profile')
}

/** DeepSeek Harness SDK JSON-RPC protocol, packages/sdk/protocol/src/types.ts. */
export class DshRuntimeDriver implements ExternalRuntimeDriver {
  readonly kind = 'dsh' as const
  readonly capabilities = { navoTools: false, nativeTools: true, approvals: false, images: false, resume: true, fork: false, tokenStreaming: false }

  async run(context: ExternalRuntimeContext): Promise<RunResult> {
    const { request, profile } = context
    if (request.input.kind !== 'message') throw new Error('DSH approval resume is not supported')
    if (request.input.images.length) throw new Error('DSH image input is not supported by this adapter')
    if (!profile.provider || !profile.model) throw new Error('Configure an explicit DSH provider and model before running')
    validateDshArgs(profile.args)
    const dshHome = process.env.DSH_HOME ?? ''
    if (context.session && context.session.dshHome !== dshHome)
      throw new Error('DSH home changed; restore the original DSH_HOME before resuming this conversation')
    await mkdir(context.stateDir, { recursive: true })
    const sessionId = context.session?.sessionId ?? randomUUID()
    let finalText = ''
    let error: string | undefined
    let aborted = false
    let terminalSeen = false
    let completed = false
    const seenEvents = new Set<number>()
    const child = new JsonLineProcess({
      command: profile.command,
      args: [...profile.args, '--profile', 'sdk'],
      cwd: request.paths.workspace,
      signal: context.signal,
      onMessage: (message) => {
        if (completed) return
        if (typeof message.method === 'string' && message.id != null) {
          if (message.method === 'approval/request') {
            child.send({ jsonrpc: '2.0', id: message.id, result: { outcome: 'rejected' } })
            error = 'DSH requested approval; this Navo runtime adapter does not support native approvals. The operation was rejected.'
          } else if (message.method === 'user-question/ask') {
            child.send({ jsonrpc: '2.0', id: message.id, result: { cancelled: true } })
            error = 'DSH requested interactive input, which is not supported by this runtime adapter.'
          } else {
            child.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported runtime request' } })
            error = `DSH requested an unsupported method: ${message.method}`
          }
          return
        }
        if (message.method !== 'session.event') return
        const params = record(message.params)
        if (params.sessionId !== sessionId) return
        const event = record(params.event)
        if (typeof event.seq !== 'number' || typeof event.type !== 'string') {
          child.fail(new Error('DSH returned an invalid session event'))
          return
        }
        if (seenEvents.has(event.seq)) return
        seenEvents.add(event.seq)
        const data = record(event.data)
        if (event.type === 'assistant/message') {
          const assistant = record(data.message)
          if (!Array.isArray(assistant.content)) {
            child.fail(new Error('DSH returned invalid assistant content'))
            return
          }
          finalText = assistant.content
            .map((block) => {
              const item = record(block)
              return item.type === 'text' && typeof item.text === 'string' ? item.text : ''
            })
            .join('')
          context.emit({
            type: 'message',
            threadId: request.threadId,
            message: { id: `${request.runId}:dsh:${event.seq}`, role: 'assistant', content: finalText },
          })
          const usage = record(data.usage)
          if (typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number')
            context.usage({
              threadId: request.threadId,
              model: profile.model!,
              usage: { input: usage.inputTokens, output: usage.outputTokens, cached: typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : 0 },
            })
        }
        if (event.type === 'tool/call') {
          let args: Record<string, unknown>
          try {
            args = record(JSON.parse(String(data.arguments)))
          } catch {
            args = { raw: data.arguments }
          }
          context.emit({
            type: 'message',
            threadId: request.threadId,
            message: {
              id: `${request.runId}:dsh:tool:${String(data.callId)}`,
              role: 'assistant',
              content: '',
              toolCalls: [{ id: String(data.callId), name: String(data.name), args }],
            },
          })
        }
        if (event.type === 'tool/result') {
          const result = record(data.message)
          const content = Array.isArray(result.content)
            ? result.content
                .map((block) => {
                  const item = record(block)
                  return typeof item.text === 'string' ? item.text : ''
                })
                .join('\n')
            : ''
          context.emit({
            type: 'message',
            threadId: request.threadId,
            message: { id: `${request.runId}:dsh:result:${event.seq}`, role: 'tool', content, toolCallId: String(result.toolCallId) },
          })
        }
        if (event.type === 'turn/end') {
          terminalSeen = true
          const reason = record(data.reason)
          if (reason.kind === 'aborted') aborted = true
          else if (reason.kind !== 'completed') error ??= String(record(reason.error).message ?? `DSH turn ended: ${String(reason.kind)}`)
        }
      },
    })
    try {
      const initialized = record(
        (
          await child.request({
            jsonrpc: '2.0',
            method: 'initialize',
            params: {
              cwd: request.paths.workspace,
              provider: profile.provider,
              model: profile.model,
              approvalRequests: true,
              capabilities: { userQuestions: true },
            },
          })
        ).result,
      )
      if (record(initialized.serverInfo).name !== 'deepseek-harness-sdk-runtime') throw new Error('Unexpected DSH SDK server identity')
      if (context.session) await child.request({ jsonrpc: '2.0', method: 'session/resume', params: { sessionId } })
      const prompt = [request.systemPrompt, request.input.context, request.input.text].filter(Boolean).join('\n\n')
      const receipt = record(
        (await child.request({ jsonrpc: '2.0', method: 'session/prompt', params: { sessionId, contentBlocks: [{ type: 'text', text: prompt }] } })).result,
      )
      if (typeof receipt.messageId !== 'string' || !receipt.messageId) throw new Error('DSH did not acknowledge the submitted message')
      context.saveSession({ sessionId, dshHome })
      await Promise.race([
        child.request(
          { jsonrpc: '2.0', method: 'session/wait', params: { sessionId } },
          {
            timeoutMs: 2_147_483_647,
            onResponse: () => {
              completed = true
            },
          },
        ),
        child.failure,
      ])
      if (!terminalSeen) throw new Error('DSH settled without a terminal turn event')
      return { finalText, interrupted: false, ...(error ? { error } : {}), ...(aborted ? { aborted: true } : {}) }
    } finally {
      await child.stop()
    }
  }
}
