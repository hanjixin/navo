import { HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { tool, type StructuredTool } from '@langchain/core/tools'
import { Command } from '@langchain/langgraph'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import type Database from 'better-sqlite3'
import { CompositeBackend, FilesystemBackend, StateBackend, createDeepAgent } from 'deepagents'
import { ClearToolUsesEdit, contextEditingMiddleware, createMiddleware } from 'langchain'
import type { ChatEvent, ThreadState, Todo, UIMessage } from '@shared/types'
import { reasoningOf, textOf, toPendingInterrupt, toTodos, toUIMessage } from '../agent/messages'
import { TraceHandler } from '../dev/trace'
import { buildChatModel } from '../models/factory'
import { ScopedSkillBackend } from '../skills/scoped-backend'
import { startTracing } from './langfuse'
import type { RunRequest, RunResult, ToolCallRequest, ToolDescriptor } from './protocol'

/** Returned by forkPoint when the branch starts from an empty conversation. */
export const RESET = '__reset__'

export interface RunnerDeps {
  db: Database.Database
  checkpointsPath: string
  emit: (e: ChatEvent) => void
  callTool: (req: ToolCallRequest) => Promise<unknown>
}

/** Tools that legitimately repeat with identical arguments (the page may have changed in between). */
const REPEAT_OK = new Set([
  'browser_snapshot',
  'browser_scroll',
  'browser_press_key',
  'browser_wait_for',
  'browser_screenshot',
  'browser_history',
  'write_todos',
])
const BUDGET_WARNINGS = [40, 80, 120]

const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x,
  )

/**
 * Stops the model from looping: identical calls are refused after a few repeats, and long runs
 * get a nudge to re-plan or report back. One instance per run (state lives in the closure).
 */
function loopGuard() {
  const counts = new Map<string, number>()
  let total = 0
  return createMiddleware({
    name: 'LoopGuard',
    wrapToolCall: async (request, handler) => {
      const { name, args, id } = request.toolCall
      total++
      const key = `${name}:${stable(args)}`
      const n = (counts.get(key) ?? 0) + 1
      counts.set(key, n)
      const limit = REPEAT_OK.has(name) ? 6 : 3
      if (n >= limit) {
        return new ToolMessage({
          tool_call_id: id ?? '',
          name,
          status: 'error',
          content: `已拦截：你已经用完全相同的参数调用 ${name} ${n} 次，结果不会不同。请换一种方法（例如先 browser_snapshot 查看当前页面、改用其他工具或选择器），或向用户说明遇到的问题。`,
        })
      }
      const res = await handler(request)
      if (BUDGET_WARNINGS.includes(total) && res instanceof ToolMessage && typeof res.content === 'string') {
        res.content += `\n\n[提示] 本轮已执行 ${total} 次工具调用。请评估进展：如果目标已基本达成就总结并回复用户；如果卡住了，换一种方法或询问用户。`
      }
      return res
    },
  })
}

/** Keeps long browsing sessions affordable: old tool results (mostly page snapshots) are cleared once the context grows. */
function trimOldToolResults() {
  return contextEditingMiddleware({
    edits: [
      new ClearToolUsesEdit({
        trigger: { tokens: 40_000 },
        keep: { messages: 4 },
        excludeTools: ['write_todos', 'task'],
        placeholder: '[较早的工具结果已清理以节省上下文；如需最新页面内容请重新调用 browser_snapshot]',
      }),
    ],
  })
}

export class Runner {
  private saver: SqliteSaver
  private running = new Map<string, AbortController>()

  constructor(private readonly deps: RunnerDeps) {
    this.saver = SqliteSaver.fromConnString(deps.checkpointsPath)
  }

  abort(threadId: string): void {
    this.running.get(threadId)?.abort()
  }

  private proxyTools(req: RunRequest): { all: StructuredTool[]; web: StructuredTool[] } {
    const make = (d: ToolDescriptor) =>
      tool(
        async (args: Record<string, unknown>, config?: { toolCall?: { id?: string } }) => {
          try {
            return await this.deps.callTool({ runId: req.runId, threadId: req.threadId, name: d.name, args: args ?? {} })
          } catch (err) {
            // a failing tool is something the model should see and work around, not the end of the run
            const content = `工具 ${d.name} 执行失败：${err instanceof Error ? err.message : String(err)}`
            const id = config?.toolCall?.id
            return id ? new ToolMessage({ content, tool_call_id: id, name: d.name, status: 'error' }) : content
          }
        },
        {
          name: d.name,
          description: d.description,
          schema: d.schema,
        },
      ) as unknown as StructuredTool
    const all = req.tools.map((d) => ({ d, t: make(d) }))
    return { all: all.map((x) => x.t), web: all.filter((x) => ['browser', 'plugin', 'macro'].includes(x.d.source)).map((x) => x.t) }
  }

  private build(req: RunRequest) {
    const model = buildChatModel(req.model)
    const tools = this.proxyTools(req)
    const interruptOn = req.interruptOn.length
      ? Object.fromEntries(req.interruptOn.map((n) => [n, { allowedDecisions: ['approve', 'edit', 'reject'] as ('approve' | 'edit' | 'reject')[] }]))
      : undefined
    const backend = new CompositeBackend(new StateBackend(), {
      '/skills/': new FilesystemBackend({ rootDir: req.paths.skills, virtualMode: true }),
      '/workspace/': new FilesystemBackend({ rootDir: req.paths.workspace, virtualMode: true }),
      ...Object.fromEntries(req.mounts.map((m) => [`/ext/${m.id}/`, new ScopedSkillBackend(m.root, new Set(m.allowed))])),
      // parsed uploads: readable (read_file supports offset/limit for long documents), never writable
      '/uploads/': new ScopedSkillBackend(req.paths.uploads, null),
    })
    return createDeepAgent({
      name: 'navo',
      model,
      tools: tools.all,
      systemPrompt: req.systemPrompt,
      checkpointer: this.saver,
      backend,
      // later sources win on name clashes, so local skills override external ones
      skills: [...req.mounts.map((m) => `/ext/${m.id}/`), '/skills/'],
      interruptOn,
      middleware: [loopGuard(), trimOldToolResults()],
      subagents: req.browserSubagent
        ? [
            {
              name: 'browser-operator',
              description: '擅长在内置浏览器中完成多步骤网页任务（搜索、填表、翻页采集、下单前准备等）。传入清晰的目标与完成标准，它会返回结果摘要。',
              systemPrompt:
                '你是浏览器操作专家。使用 browser_* 工具以及匹配的 plugin_* / macro_* 工具完成任务。先用 browser_snapshot 了解页面；操作类工具会返回页面变化，无需每步都重新快照。完成后用简洁的中文总结结果与关键数据；遇到登录/验证码/不可逆操作时停止并说明原因。',
              tools: tools.web,
              interruptOn,
              middleware: [loopGuard(), trimOldToolResults()],
            },
          ]
        : [],
    })
  }

  async run(req: RunRequest): Promise<RunResult> {
    const { threadId, runId } = req
    if (this.running.has(threadId)) throw new Error('该会话正在运行中')
    const controller = new AbortController()
    this.running.set(threadId, controller)
    const emit = this.deps.emit
    let finalText = ''
    let interrupted = false
    let error: string | undefined
    const seen = new Set<string>()
    let traceUrl: string | undefined
    const tracing = await startTracing(req).catch((err) => {
      console.error('[langfuse] tracing disabled for this run:', err)
      return null
    })

    try {
      const agent = this.build(req)
      const input =
        req.input.kind === 'resume'
          ? new Command({ resume: { decisions: req.input.decisions } })
          : {
              messages: [
                new HumanMessage({
                  id: req.input.id,
                  content:
                    req.input.images.length || req.input.context
                      ? [
                          { type: 'text', text: req.input.text },
                          ...(req.input.context ? [{ type: 'text', text: req.input.context }] : []),
                          ...req.input.images.map((url) => ({ type: 'image_url', image_url: { url } })),
                        ]
                      : req.input.text,
                  // the UI shows the user's own words + attachment chips, not the injected file content
                  additional_kwargs: {
                    ...(req.input.attachments?.length
                      ? { attachments: req.input.attachments, userText: req.input.text, attachmentImages: req.input.attachmentImages ?? 0 }
                      : {}),
                    ...(req.input.memories?.length ? { memories: req.input.memories } : {}),
                  },
                }),
              ],
            }
      const stream = await agent.stream(
        input as never,
        {
          configurable: { thread_id: threadId, ...(req.fromCheckpointId ? { checkpoint_id: req.fromCheckpointId } : {}) },
          streamMode: ['messages', 'updates'],
          subgraphs: true,
          signal: controller.signal,
          recursionLimit: 250,
          runName: 'navo-agent',
          callbacks: [...(req.devMode ? [new TraceHandler(this.deps.db, threadId, runId)] : []), ...(tracing?.callbacks ?? [])],
        } as never,
      )

      for await (const chunk of stream as AsyncIterable<[string[], string, unknown]>) {
        const [namespace, mode, data] = chunk
        // subagents run inside the `tools` node, so their namespace contains a `tools:<id>` segment
        const ns = namespace.filter((n) => n.startsWith('tools:')).join('|')
        if (mode === 'messages') {
          const [msg] = data as [BaseMessage & { additional_kwargs?: Record<string, unknown> }, unknown]
          const type = (msg as unknown as { type?: string }).type ?? (msg as unknown as { _getType?: () => string })._getType?.()
          if ((type === 'ai' || type === 'AIMessageChunk') && msg.id) {
            const r = reasoningOf(msg.content, msg.additional_kwargs)
            if (r) emit({ type: 'token', threadId, messageId: msg.id, text: r, ns, reasoning: true })
            const t = textOf(msg.content)
            if (t) emit({ type: 'token', threadId, messageId: msg.id, text: t, ns })
          }
          continue
        }
        for (const [node, update] of Object.entries((data ?? {}) as Record<string, unknown>)) {
          if (node === '__interrupt__') {
            const pending = toPendingInterrupt(update)
            if (pending && !ns) {
              interrupted = true
              emit({ type: 'interrupt', threadId, interrupt: pending })
            }
            continue
          }
          const u = (update ?? {}) as { messages?: unknown; todos?: unknown }
          if (Array.isArray(u.messages)) {
            for (const m of u.messages as BaseMessage[]) {
              const ui = toUIMessage(m, ns)
              if (!ui || seen.has(ui.id + ui.role)) continue
              seen.add(ui.id + ui.role)
              if (ui.role === 'user' && !ns) continue // emitted by the main process on send
              emit({ type: 'message', threadId, message: ui })
              if (ui.role === 'assistant' && !ns && ui.content) finalText = ui.content
            }
          }
          const todos: Todo[] | null = toTodos(u.todos)
          if (todos && !ns) emit({ type: 'todos', threadId, todos })
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        error = err instanceof Error ? err.message : String(err)
        emit({ type: 'error', threadId, error })
      }
    } finally {
      this.running.delete(threadId)
      traceUrl = await tracing?.finish().catch(() => undefined)
    }
    return { finalText, interrupted, error, aborted: controller.signal.aborted, traceUrl }
  }

  async state(threadId: string): Promise<Omit<ThreadState, 'running'>> {
    const tuple = await this.saver.getTuple({ configurable: { thread_id: threadId } })
    const values = (tuple?.checkpoint.channel_values ?? {}) as { messages?: BaseMessage[]; todos?: unknown }
    const messages = (values.messages ?? []).map((m) => toUIMessage(m)).filter((m): m is UIMessage => !!m)
    const interruptWrite = tuple?.pendingWrites?.find(([, channel]) => channel === '__interrupt__')
    return { messages, todos: toTodos(values.todos) ?? [], interrupt: interruptWrite ? toPendingInterrupt(interruptWrite[2]) : null }
  }

  /**
   * Finds the checkpoint right before `messageId` was added, so the conversation can branch from
   * there (regenerate / edit & resend). Returns null when the message is not a user message.
   */
  async forkPoint(threadId: string, messageId: string): Promise<string | null> {
    const latest = await this.saver.getTuple({ configurable: { thread_id: threadId } })
    const msgs = ((latest?.checkpoint.channel_values ?? {}) as { messages?: BaseMessage[] }).messages ?? []
    const idx = msgs.findIndex((m) => m.id === messageId)
    if (idx < 0) return null
    // branching from the very first message is simply a fresh start
    if (idx === 0) return RESET
    const prevId = msgs[idx - 1].id
    for await (const t of this.saver.list({ configurable: { thread_id: threadId, checkpoint_ns: '' } })) {
      // "input" checkpoints still hold the old message as a pending write; branching there would replay it
      if ((t.metadata as { source?: string } | undefined)?.source === 'input') continue
      const ms = ((t.checkpoint.channel_values ?? {}) as { messages?: BaseMessage[] }).messages ?? []
      if (ms.length === idx && ms[idx - 1]?.id === prevId) return (t.config.configurable?.checkpoint_id as string) ?? null
    }
    return null
  }

  async deleteThread(threadId: string): Promise<void> {
    this.abort(threadId)
    await this.saver.deleteThread(threadId)
  }
}
