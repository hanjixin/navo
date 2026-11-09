import type { RunResult } from '../contracts'
import type { ExternalRuntimeContext, ExternalRuntimeDriver } from '../types'
import { JsonLineProcess, record } from '../process'

const reservedClaudeFlags = new Set([
  '--print',
  '-p',
  '--input-format',
  '--output-format',
  '--include-partial-messages',
  '--verbose',
  '--tools',
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--permission-mode',
  '--permission-prompts',
  '--permission-prompt-tool',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--mcp-config',
  '--strict-mcp-config',
  '--settings',
  '--setting-sources',
  '--resume',
  '-r',
  '--continue',
  '-c',
  '--session-id',
  '--fork-session',
  '--no-session-persistence',
  '--system-prompt',
  '--system-prompt-file',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--model',
  '--fallback-model',
  '--add-dir',
  '--plugin-dir',
  '--plugin-url',
  '--chrome',
  '--worktree',
  '-w',
  '--remote-control',
  '--desktop',
  '--cloud',
  '--background',
  '--bg',
])

export function validateClaudeArgs(args: string[]): void {
  for (const argument of args) {
    const flag = argument.split('=', 1)[0]
    if (argument === '--' || reservedClaudeFlags.has(flag) || /^-[prcw].+/.test(argument)) {
      throw new Error(`Claude runtime argument is managed by Navo: ${flag}`)
    }
  }
}

/** Print mode deliberately exposes no local or MCP tools until native approvals are bridged. */
export class ClaudeRuntimeDriver implements ExternalRuntimeDriver {
  readonly kind = 'claude' as const
  readonly capabilities = {
    navoTools: false,
    nativeTools: false,
    approvals: false,
    images: false,
    resume: true,
    fork: false,
    tokenStreaming: true,
  }

  async run(context: ExternalRuntimeContext): Promise<RunResult> {
    const { request, profile, signal } = context
    if (signal.aborted) return { finalText: '', interrupted: false, aborted: true }
    if (request.input.kind !== 'message') throw new Error('Claude runtime does not support approval resume')
    if (request.input.images.length) throw new Error('Claude runtime does not support images')
    validateClaudeArgs(profile.args)
    const args = [
      ...profile.args,
      '--print',
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--permission-mode',
      'dontAsk',
      '--settings',
      '{"disableAllHooks":true}',
    ]
    if (profile.model) args.push('--model', profile.model)
    if (request.systemPrompt) args.push('--append-system-prompt', request.systemPrompt)
    if (context.session?.sessionId) args.push('--resume', context.session.sessionId)
    let finalText = ''
    let completed = false
    let messageId = `${request.runId}:claude:assistant`
    const streamed = new Map<string, string>()
    let complete!: (result: RunResult) => void
    const result = new Promise<RunResult>((resolve) => {
      complete = resolve
    })
    let child: JsonLineProcess | undefined
    try {
      child = new JsonLineProcess({
        command: profile.command,
        args,
        cwd: request.paths.workspace,
        signal,
        onMessage: (message) => {
          if (completed) return
          if (message.type === 'control_request') {
            // This mode cannot ask the user to approve native actions. Fail closed.
            child?.send({
              type: 'control_response',
              response: {
                subtype: 'error',
                request_id: message.request_id,
                error: 'Native approvals are not supported by the Navo Claude adapter',
              },
            })
            throw new Error('Claude requested a native approval; this adapter has tools disabled')
          }
          if (message.type === 'system' && message.subtype === 'init' && typeof message.session_id === 'string') {
            context.saveSession({ sessionId: message.session_id })
          }
          if (message.type === 'stream_event') {
            const event = record(message.event)
            if (event.type === 'message_start' && typeof record(event.message).id === 'string') {
              messageId = `${request.runId}:claude:${String(record(event.message).id)}`
            }
            const delta = record(event.delta)
            if (event.type === 'content_block_delta' && delta.type === 'text_delta' && typeof delta.text === 'string') {
              streamed.set(messageId, (streamed.get(messageId) ?? '') + delta.text)
              context.emit({ type: 'token', threadId: request.threadId, messageId, text: delta.text })
            }
          }
          if (message.type === 'assistant') {
            const assistant = record(message.message)
            const blocks = Array.isArray(assistant.content) ? assistant.content.map(record) : []
            if (blocks.some((block) => block.type === 'tool_use')) {
              throw new Error('Claude emitted a tool call despite tools being disabled')
            }
            const content = blocks
              .filter((block) => block.type === 'text')
              .map((block) => String(block.text ?? ''))
              .join('')
            messageId = typeof assistant.id === 'string' ? `${request.runId}:claude:${assistant.id}` : messageId
            if (content) {
              finalText = content
              context.emit({ type: 'message', threadId: request.threadId, message: { id: messageId, role: 'assistant', content } })
            }
          }
          if (message.type === 'result') {
            completed = true
            if (typeof message.session_id === 'string') context.saveSession({ sessionId: message.session_id })
            const usage = record(message.usage)
            const count = (key: string): number => (typeof usage[key] === 'number' && Number.isFinite(usage[key]) ? Math.max(0, usage[key] as number) : 0)
            context.usage({
              threadId: request.threadId,
              model: profile.model ?? 'claude',
              usage: {
                input: count('input_tokens') + count('cache_creation_input_tokens') + count('cache_read_input_tokens'),
                output: count('output_tokens'),
                cached: count('cache_read_input_tokens'),
              },
            })
            if (typeof message.result === 'string' && message.result && message.result !== finalText) {
              finalText = message.result
              context.emit({ type: 'message', threadId: request.threadId, message: { id: messageId, role: 'assistant', content: finalText } })
            }
            finalText ||= [...streamed.values()].join('\n')
            const failed = message.is_error === true || (typeof message.subtype === 'string' && message.subtype !== 'success')
            const errors = Array.isArray(message.errors) ? message.errors.map(String).join('\n') : ''
            complete({ finalText, interrupted: false, ...(failed ? { error: errors || String(message.result || 'Claude runtime failed') } : {}) })
          }
        },
      })
      const text = [request.input.text, request.input.context].filter(Boolean).join('\n\n')
      child.send({ type: 'user', session_id: context.session?.sessionId ?? '', message: { role: 'user', content: text }, parent_tool_use_id: null })
      return await Promise.race([result, child.failure])
    } catch (error) {
      finalText ||= [...streamed.values()].join('\n')
      if (signal.aborted) return { finalText, interrupted: false, aborted: true }
      throw error
    } finally {
      await child?.stop()
    }
  }
}
