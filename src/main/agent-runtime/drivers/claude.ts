import { randomUUID } from 'node:crypto'
import { RuntimeTextStream, normalizeRuntimeText } from '../message-normalizer'
import { ClaudeMcpBridge } from './claude-mcp'
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
  '--system-prompt-snapshot',
  '--disable-slash-commands',
  '--no-chrome',
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

/** Claude owns its model/session; only the run-scoped Navo MCP bridge can execute tools. */
export class ClaudeRuntimeDriver implements ExternalRuntimeDriver {
  readonly kind = 'claude' as const
  readonly capabilities = {
    navoTools: true,
    nativeTools: false,
    approvals: true,
    requiresNavoModel: false,
    workspaceTools: true,
    images: true,
    resume: true,
    fork: false,
    tokenStreaming: true,
  }

  async run(context: ExternalRuntimeContext): Promise<RunResult> {
    const { request, profile, signal } = context
    if (signal.aborted) return { finalText: '', interrupted: false, aborted: true }
    if (request.input.kind !== 'message') throw new Error('Claude approval resume must continue the live tool bridge')
    if (request.tools.length && !context.tools) throw new Error('Claude requires a Navo tool bridge for this run')
    validateClaudeArgs(profile.args)
    const bridge = context.tools ? new ClaudeMcpBridge(context) : null
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
      JSON.stringify({ mcpServers: bridge ? { navo: { type: 'sdk', name: 'navo' } } : {} }),
      '--permission-mode',
      'dontAsk',
      '--settings',
      '{"disableAllHooks":true}',
      '--system-prompt-snapshot',
      'off',
      '--disable-slash-commands',
      '--no-chrome',
    ]
    if (bridge?.allowedTools.length) args.push('--allowedTools', ...bridge.allowedTools)
    if (profile.model) args.push('--model', profile.model)
    if (request.systemPrompt) args.push('--append-system-prompt', request.systemPrompt)
    if (context.session?.sessionId) args.push('--resume', context.session.sessionId)
    let finalText = ''
    let initializedBridge = false
    let actualModel = profile.model ?? 'claude'
    let completed = false
    let messageId = `${request.runId}:claude:assistant`
    let markupWarning = false
    const streams = new Map<string, RuntimeTextStream>()
    const initializationId = randomUUID()
    let initializeResolve!: () => void
    let initializeReject!: (error: Error) => void
    const initialized = new Promise<void>((resolve, reject) => {
      initializeResolve = resolve
      initializeReject = reject
    })
    void initialized.catch(() => {})
    let initializationTimer: ReturnType<typeof setTimeout> | undefined
    let complete!: (result: RunResult) => void
    const result = new Promise<RunResult>((resolve) => {
      complete = resolve
    })
    let child: JsonLineProcess | undefined
    const publishText = (raw: string) => {
      const normalized = normalizeRuntimeText(raw)
      markupWarning ||= normalized.diagnostics.length > 0
      finalText = normalized.text
      context.emit({
        type: 'message',
        threadId: request.threadId,
        message: {
          id: messageId,
          role: 'assistant',
          content: normalized.text,
          ...(markupWarning ? { runtimeWarning: 'unexecuted_tool_markup' as const } : {}),
        },
      })
    }
    const flushStreams = () => {
      for (const [id, stream] of streams) {
        const normalized = stream.finish()
        markupWarning ||= normalized.diagnostics.length > 0
        if (normalized.diagnostics.length)
          context.emit({
            type: 'message',
            threadId: request.threadId,
            message: { id, role: 'assistant', content: normalized.text, runtimeWarning: 'unexecuted_tool_markup' },
          })
      }
    }
    try {
      child = new JsonLineProcess({
        command: profile.command,
        args,
        cwd: request.paths.workspace,
        signal,
        onMessage: (message) => {
          if (completed) return
          if (message.type === 'control_response') {
            const response = record(message.response)
            if (response.request_id === initializationId) {
              if (response.subtype === 'success') {
                initializedBridge = true
                initializeResolve()
              } else initializeReject(new Error(String(response.error ?? 'Claude initialization failed')))
            }
            return
          }
          if (message.type === 'control_cancel_request') {
            bridge?.cancel(message.request_id)
            return
          }
          if (message.type === 'control_request') {
            const control = record(message.request)
            if (control.subtype === 'mcp_message' && bridge) {
              // MCP calls may wait for approval. Never await them on the protocol reader.
              void bridge
                .handle(message, (response) => child?.send(response))
                .catch((error) => child?.fail(error instanceof Error ? error : new Error(String(error))))
              return
            }
            if (control.subtype === 'can_use_tool' && bridge?.hasNativeName(control.tool_name)) {
              child?.send({
                type: 'control_response',
                response: { subtype: 'success', request_id: message.request_id, response: { behavior: 'allow', updatedInput: record(control.input) } },
              })
              return
            }
            child?.send({
              type: 'control_response',
              response: {
                subtype: 'success',
                request_id: message.request_id,
                response: { behavior: 'deny', message: 'Only run-scoped Navo tools are available', interrupt: true },
              },
            })
            throw new Error('Claude requested an unsupported native approval or interaction')
          }
          if (message.type === 'system' && message.subtype === 'init') {
            if (Array.isArray(message.tools) && message.tools.some((name) => !bridge?.hasNativeName(name))) {
              throw new Error('Claude loaded tools outside the Navo bridge; this runtime requires only Navo MCP tools')
            }
            if (typeof message.session_id === 'string') context.saveSession({ sessionId: message.session_id })
            if (typeof message.model === 'string') actualModel = message.model
          }
          if (message.type === 'stream_event') {
            const event = record(message.event)
            if (event.type === 'message_start' && typeof record(event.message).id === 'string') {
              messageId = `${request.runId}:claude:${String(record(event.message).id)}`
            }
            const delta = record(event.delta)
            if (event.type === 'content_block_delta' && delta.type === 'text_delta' && typeof delta.text === 'string') {
              let stream = streams.get(messageId)
              if (!stream) {
                stream = new RuntimeTextStream()
                streams.set(messageId, stream)
              }
              const text = stream.push(delta.text)
              if (text) context.emit({ type: 'token', threadId: request.threadId, messageId, text })
            }
          }
          if (message.type === 'assistant') {
            const assistant = record(message.message)
            if (typeof assistant.model === 'string') actualModel = assistant.model
            const blocks = Array.isArray(assistant.content) ? assistant.content.map(record) : []
            if (blocks.some((block) => block.type === 'tool_use' && !bridge?.hasNativeName(block.name))) {
              throw new Error('Claude emitted a native tool call despite native tools being disabled')
            }
            const content = blocks
              .filter((block) => block.type === 'text')
              .map((block) => String(block.text ?? ''))
              .join('')
            messageId = typeof assistant.id === 'string' ? `${request.runId}:claude:${assistant.id}` : messageId
            if (content) publishText(content)
          }
          if (message.type === 'result') {
            completed = true
            const unfinishedTools = bridge?.hasPending === true
            bridge?.close()
            if (typeof message.session_id === 'string') context.saveSession({ sessionId: message.session_id })
            const usage = record(message.usage)
            const count = (key: string): number => (typeof usage[key] === 'number' && Number.isFinite(usage[key]) ? Math.max(0, usage[key] as number) : 0)
            context.usage({
              threadId: request.threadId,
              model: actualModel,
              usage: {
                input: count('input_tokens') + count('cache_creation_input_tokens') + count('cache_read_input_tokens'),
                output: count('output_tokens'),
                cached: count('cache_read_input_tokens'),
              },
            })
            flushStreams()
            if (typeof message.result === 'string' && message.result) publishText(message.result)
            if (!finalText) finalText = [...streams.values()].map((stream) => stream.finish().text).join('\n')
            const failed = message.is_error === true || (typeof message.subtype === 'string' && message.subtype !== 'success')
            const errors = Array.isArray(message.errors) ? message.errors.map(String).join('\n') : ''
            complete({
              finalText,
              interrupted: false,
              ...(unfinishedTools
                ? { error: 'Claude ended with unresolved Navo tool calls' }
                : failed
                  ? { error: errors || finalText || 'Claude runtime failed' }
                  : markupWarning
                    ? { error: 'The model returned unexecuted tool markup instead of a structured tool call' }
                    : {}),
            })
          }
        },
      })
      if (bridge) {
        initializationTimer = setTimeout(() => initializeReject(new Error('Claude initialization timed out')), 30_000)
        child.send({ type: 'control_request', request_id: initializationId, request: { subtype: 'initialize', hooks: null } })
        await Promise.race([
          initialized,
          child.failure,
          result.then((value) => {
            throw new Error(value.error || 'Claude completed before initialization')
          }),
        ])
        clearTimeout(initializationTimer)
      }
      const text = [request.input.text, request.input.context].filter(Boolean).join('\n\n')
      const imageBlocks = request.input.images.map((url) => {
        const match = /^data:(image\/[\w.+-]+);base64,([\s\S]+)$/.exec(url)
        if (!match) throw new Error('Claude image input must be a base64 image data URL')
        return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }
      })
      const content = imageBlocks.length ? [{ type: 'text', text }, ...imageBlocks] : text
      child.send({ type: 'user', session_id: context.session?.sessionId ?? '', message: { role: 'user', content }, parent_tool_use_id: null })
      return await Promise.race([result, child.failure])
    } catch (error) {
      flushStreams()
      finalText ||= [...streams.values()].map((stream) => stream.finish().text).join('\n')
      if (signal.aborted) return { finalText, interrupted: false, aborted: true }
      if (bridge && !initializedBridge) {
        throw new Error(
          `Claude MCP initialization failed (tested with Claude Code 2.1.307; the CLI must support SDK MCP and system-prompt-snapshot): ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
      throw error
    } finally {
      clearTimeout(initializationTimer)
      completed = true
      bridge?.close()
      await child?.stop()
    }
  }
}
