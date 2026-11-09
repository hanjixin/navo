import { mkdir } from 'node:fs/promises'
import { JsonLineProcess, record } from '../process'
import type { ExternalRuntimeContext, ExternalRuntimeDriver } from '../types'
import type { RunResult } from '../contracts'

export function validatePiArgs(args: string[]): void {
  const managed =
    /^(?:--(?:mode|print|model|provider|tools|exclude-tools|extension|skill|prompt-template|session|session-id|session-dir|no-session|continue|resume|fork|approve|system-prompt|append-system-prompt)(?:=|$)|-(?:e|s|c|r|a|p)(?:$|[^-]))/
  if (args.some((arg) => arg === '--' || managed.test(arg)))
    throw new Error('Pi runtime arguments cannot override managed tools, sessions, or protocol settings')
}

/** Pi RPC protocol: https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs */
export class PiRuntimeDriver implements ExternalRuntimeDriver {
  readonly kind = 'pi' as const
  readonly capabilities = { navoTools: false, nativeTools: false, approvals: false, images: false, resume: true, fork: false, tokenStreaming: true }

  async run(context: ExternalRuntimeContext): Promise<RunResult> {
    const { request, profile } = context
    if (request.input.kind !== 'message') throw new Error('Pi approval resume is not supported')
    if (request.input.images.length) throw new Error('Pi image input is not supported by this adapter')
    validatePiArgs(profile.args)
    await mkdir(context.stateDir, { recursive: true })
    const args = [
      ...profile.args,
      '--mode',
      'rpc',
      '--session-dir',
      context.stateDir,
      '--no-tools',
      '--no-extensions',
      '--no-mcp',
      '--no-skills',
      '--no-prompt-templates',
      '--no-approve',
    ]
    if (profile.model) args.push('--model', profile.model)
    if (profile.provider) {
      if (!profile.model) throw new Error('Pi provider requires an explicit model')
      args.push('--provider', profile.provider)
    }
    let finalText = ''
    let streamed = ''
    let index = 0
    let messageId = `${request.runId}:pi:${index}`
    let completed = false
    let modelError: string | undefined
    let settle!: (value: RunResult) => void
    const finished = new Promise<RunResult>((resolve) => {
      settle = resolve
    })
    const process = new JsonLineProcess({
      command: profile.command,
      args,
      cwd: request.paths.workspace,
      signal: context.signal,
      onMessage: (message) => {
        if (completed) return
        if (message.type === 'extension_ui_request') {
          process.send({ type: 'extension_ui_response', id: message.id, cancelled: true })
          process.fail(new Error('Pi requested interactive input; this runtime adapter does not support approvals or dialogs'))
          return
        }
        if (message.type === 'tool_execution_start') {
          process.fail(new Error('Pi attempted a native tool despite tools being disabled'))
          return
        }
        if (message.type === 'message_start' && record(message.message).role === 'assistant') {
          messageId = `${request.runId}:pi:${index++}`
          streamed = ''
        }
        if (message.type === 'message_update') {
          const update = record(message.assistantMessageEvent)
          if (update.type === 'text_delta' && typeof update.delta === 'string') {
            streamed += update.delta
            context.emit({ type: 'token', threadId: request.threadId, messageId, text: update.delta })
          }
        }
        if (message.type === 'message_end') {
          const assistant = record(message.message)
          if (assistant.role !== 'assistant') return
          finalText = Array.isArray(assistant.content)
            ? assistant.content
                .map((block) => {
                  const item = record(block)
                  return item.type === 'text' && typeof item.text === 'string' ? item.text : ''
                })
                .join('')
            : streamed
          context.emit({ type: 'message', threadId: request.threadId, message: { id: messageId, role: 'assistant', content: finalText } })
          modelError = undefined
          if (assistant.stopReason === 'error') modelError = typeof assistant.errorMessage === 'string' ? assistant.errorMessage : 'Pi model request failed'
          if (assistant.stopReason === 'aborted') modelError = 'Pi model request was aborted'
          const usage = record(assistant.usage)
          if (typeof usage.input === 'number' && typeof usage.output === 'number')
            context.usage({
              threadId: request.threadId,
              model: typeof assistant.model === 'string' ? assistant.model : (profile.model ?? 'pi'),
              usage: { input: usage.input, output: usage.output, cached: typeof usage.cacheRead === 'number' ? usage.cacheRead : 0 },
            })
        }
        if (message.type === 'agent_settled') {
          completed = true
          settle({ finalText, interrupted: false, ...(modelError ? { error: modelError } : {}), ...(message.aborted === true ? { aborted: true } : {}) })
        }
      },
    })
    try {
      if (context.session?.sessionFile) {
        const response = await process.request({ type: 'switch_session', sessionPath: context.session.sessionFile })
        if (record(response.data).cancelled !== false) throw new Error('Pi session restoration was cancelled or not confirmed')
      }
      const state = record((await process.request({ type: 'get_state' })).data)
      if (typeof state.sessionFile !== 'string' || !state.sessionFile) throw new Error('Pi did not return a persistent session file')
      context.saveSession({ sessionFile: state.sessionFile })
      const prompt = [request.systemPrompt, request.input.context, request.input.text].filter(Boolean).join('\n\n')
      const response = await process.request({ type: 'prompt', message: prompt })
      if (record(response.data).disposition === 'handled') throw new Error('Pi handled the prompt without starting a model run')
      const result = await Promise.race([finished, process.failure])
      return result
    } finally {
      await process.stop()
    }
  }
}
