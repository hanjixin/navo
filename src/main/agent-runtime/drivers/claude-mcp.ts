import type { ExternalRuntimeContext } from '../types'
import { record } from '../process'

type WireMessage = Record<string, unknown>
type CallState = { id: string; cancelled: boolean; signature: string; response: Promise<WireMessage> }

/** SDK MCP travels inside Claude's control protocol, scoped to this one Navo execution. */
export class ClaudeMcpBridge {
  private readonly definitions
  private readonly calls = new Map<string, CallState>()
  private readonly controls = new Map<string, CallState>()
  private closed = false

  constructor(private readonly context: ExternalRuntimeContext) {
    this.definitions = new Map(context.request.tools.map((tool) => [tool.name, tool]))
    for (const name of this.definitions.keys()) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(name)) throw new Error('Claude MCP tool name is invalid')
    }
  }

  get allowedTools(): string[] {
    return [...this.definitions.keys()].map((name) => `mcp__navo__${name}`)
  }

  get hasPending(): boolean {
    return [...this.controls.values()].some((call) => !call.cancelled)
  }

  hasNativeName(name: unknown): boolean {
    return typeof name === 'string' && name.startsWith('mcp__navo__') && this.definitions.has(name.slice('mcp__navo__'.length))
  }

  cancel(requestId: unknown): void {
    if (typeof requestId !== 'string') return
    const call = this.controls.get(requestId)
    if (!call || call.cancelled) return
    call.cancelled = true
    this.context.tools?.cancel?.(call.id)
  }

  close(): void {
    this.closed = true
    for (const id of this.controls.keys()) this.cancel(id)
    this.controls.clear()
  }

  async handle(control: WireMessage, send: (message: WireMessage) => void): Promise<void> {
    const controlId = control.request_id
    if (typeof controlId !== 'string' || !controlId) throw new Error('Claude MCP control request has no ID')
    const request = record(control.request)
    if (request.subtype !== 'mcp_message') throw new Error('Unsupported Claude MCP control request')
    const message = record(request.message)
    const rpcId = message.id
    const error = (code: number, text: string): WireMessage => ({ jsonrpc: '2.0', id: rpcId ?? null, error: { code, message: text } })
    let response: WireMessage
    if (request.server_name !== 'navo') response = error(-32601, 'Unknown Navo MCP server')
    else if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') response = error(-32600, 'Invalid MCP request')
    else if (message.method === 'initialize') {
      response = {
        jsonrpc: '2.0',
        id: rpcId,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'navo', version: this.context.request.meta.appVersion },
        },
      }
    } else if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') {
      if (message.method === 'notifications/cancelled') {
        const state = this.calls.get(String(record(message.params).requestId))
        if (state && !state.cancelled) {
          state.cancelled = true
          this.context.tools?.cancel?.(state.id)
        }
      }
      response = { jsonrpc: '2.0', result: {} }
    } else if (message.method === 'ping') response = { jsonrpc: '2.0', id: rpcId, result: {} }
    else if (message.method === 'tools/list') {
      response = {
        jsonrpc: '2.0',
        id: rpcId,
        result: { tools: [...this.definitions.values()].map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.schema })) },
      }
    } else if (message.method === 'tools/call') {
      const params = record(message.params)
      if ((typeof rpcId !== 'string' && typeof rpcId !== 'number') || !this.definitions.has(String(params.name))) {
        response = error(-32602, 'Unknown or invalid Navo tool call')
      } else if (!this.context.tools) response = error(-32603, 'Navo tool bridge is not available')
      else if (params.arguments != null && (typeof params.arguments !== 'object' || Array.isArray(params.arguments)))
        response = error(-32602, 'Tool arguments must be an object')
      else {
        const key = String(rpcId)
        const signature = JSON.stringify({ name: params.name, args: params.arguments })
        let state = this.calls.get(key)
        if (state && state.signature !== signature) {
          send({
            type: 'control_response',
            response: {
              subtype: 'success',
              request_id: controlId,
              response: { mcp_response: error(-32600, 'MCP request ID was reused with different arguments') },
            },
          })
          return
        }
        if (!state) {
          const id = `${this.context.request.runId}:claude-mcp:${key}`
          state = { id, cancelled: false, signature, response: Promise.resolve({}) }
          const current = state
          state.response = Promise.resolve().then(async () => {
            if (this.closed || current.cancelled || this.context.signal.aborted) return error(-32800, 'Tool request cancelled')
            try {
              const result = await this.context.tools!.call({ id, name: String(params.name), args: record(params.arguments) })
              return { jsonrpc: '2.0', id: rpcId, result }
            } catch (cause) {
              return {
                jsonrpc: '2.0',
                id: rpcId,
                result: { content: [{ type: 'text', text: cause instanceof Error ? cause.message : 'Navo tool failed' }], isError: true },
              }
            }
          })
          this.calls.set(key, state)
        }
        this.controls.set(controlId, state)
        response = await state.response
        if (state.cancelled) return
      }
    } else response = error(-32601, 'Unsupported MCP method')
    if (this.closed || this.context.signal.aborted) return
    send({ type: 'control_response', response: { subtype: 'success', request_id: controlId, response: { mcp_response: response } } })
    this.controls.delete(controlId)
  }
}
