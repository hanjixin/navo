import { Bot, Brain, Check, ChevronRight, Copy, Pencil, RotateCcw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { UIMessage } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { ChatMessage } from '@/stores/chat'
import { MemoryRefs } from './memory-refs'
import { AttachmentChip } from '@/components/files/attachment-chip'
import { Markdown } from './markdown'
import { ToolCard } from './tool-card'

type Block = { kind: 'user'; msg: ChatMessage } | { kind: 'assistant'; msg: ChatMessage } | { kind: 'sub'; ns: string; msgs: ChatMessage[] }

function group(messages: ChatMessage[]): Block[] {
  const blocks: Block[] = []
  for (const m of messages) {
    if (m.role === 'tool' && !m.ns) continue // rendered inside the calling ToolCard
    if (m.ns) {
      const last = blocks.at(-1)
      if (last?.kind === 'sub' && last.ns === m.ns) last.msgs.push(m)
      else blocks.push({ kind: 'sub', ns: m.ns, msgs: [m] })
      continue
    }
    blocks.push(m.role === 'user' ? { kind: 'user', msg: m } : { kind: 'assistant', msg: m })
  }
  return blocks
}

export interface MessageActions {
  onRegenerate: (userMessageId: string) => void
  onEdit: (userMessageId: string, text: string) => void
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <Tooltip content={done ? '已复制' : '复制'} side="top">
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-6"
        aria-label="复制"
        onClick={() => {
          void navigator.clipboard.writeText(text)
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        }}
      >
        {done ? <Check className="text-success" /> : <Copy />}
      </Button>
    </Tooltip>
  )
}

/** Model thinking: open while it streams in, folded once the answer starts. */
function Reasoning({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(live)
  useEffect(() => {
    if (!live) setOpen(false)
  }, [live])
  return (
    <div className="rounded-md border border-border/70 bg-muted/40">
      <button
        onClick={() => setOpen((v) => !v)}
        className="interactive flex h-7 w-full items-center gap-1.5 px-2.5 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn('size-3 transition-transform duration-150', open && 'rotate-90')} />
        <Brain className="size-3.5 stroke-[1.75]" />
        {live ? '正在思考…' : '思考过程'}
        <span className="text-subtle-foreground">· {text.length} 字</span>
        {live ? <span className="ml-1 size-1.5 animate-pulse rounded-full bg-brand" /> : null}
      </button>
      {open ? (
        <div className="selectable max-h-72 animate-fade-in overflow-y-auto border-t border-border/70 px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {text}
        </div>
      ) : null}
    </div>
  )
}

function AssistantBlock({
  msg,
  results,
  running,
  onRegenerate,
}: {
  msg: ChatMessage
  results: Map<string, UIMessage>
  running: boolean
  onRegenerate?: () => void
}) {
  const hasText = !!msg.content.trim()
  return (
    <div className="group/msg grid min-w-0 animate-fade-in grid-cols-[minmax(0,1fr)] gap-2">
      {msg.reasoning ? <Reasoning text={msg.reasoning} live={!!msg.streaming && !hasText} /> : null}
      {hasText ? (
        <div className="relative">
          <Markdown text={msg.content} />
          {msg.streaming ? <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-caret bg-foreground/70" /> : null}
        </div>
      ) : null}
      {msg.toolCalls?.length ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
          {msg.toolCalls.map((c) => (
            <ToolCard key={c.id} call={c} result={results.get(c.id)} pending={running} />
          ))}
        </div>
      ) : null}
      {hasText && !msg.streaming ? (
        <div className="-mt-1 flex gap-0.5 opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100 focus-within:opacity-100">
          <CopyButton text={msg.content} />
          {onRegenerate && !running ? (
            <Tooltip content="重新生成" side="top">
              <Button variant="ghost" size="icon-sm" className="size-6" onClick={onRegenerate} aria-label="重新生成">
                <RotateCcw />
              </Button>
            </Tooltip>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function UserBubble({ msg, running, onEdit }: { msg: ChatMessage; running: boolean; onEdit?: (text: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(msg.content)
  const submit = () => {
    if (!draft.trim()) return
    setEditing(false)
    onEdit?.(draft.trim())
  }
  if (editing) {
    return (
      <div className="ml-auto grid w-[85%] animate-fade-in gap-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={Math.min(8, Math.max(2, draft.split('\n').length))}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            } else if (e.key === 'Escape') setEditing(false)
          }}
        />
        <div className="flex justify-end gap-1.5">
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
            取消
          </Button>
          <Button variant="primary" size="sm" disabled={!draft.trim()} onClick={submit}>
            发送
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div className="group/user flex animate-fade-in flex-col items-end gap-1">
      {msg.attachments?.length ? (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {msg.attachments.map((a) => (
            <AttachmentChip key={a.id} id={a.id} fallback={a} />
          ))}
        </div>
      ) : null}
      {msg.content || msg.images?.length ? (
        <div className="selectable max-w-[85%] rounded-lg bg-secondary px-3.5 py-2 text-sm whitespace-pre-wrap">
          {msg.images?.length ? (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {msg.images.map((src, j) => (
                <img key={j} src={src} className="max-h-32 rounded-sm" alt="" />
              ))}
            </div>
          ) : null}
          {msg.content}
        </div>
      ) : null}
      <div className="flex items-center gap-0.5">
        {msg.memories?.length ? <MemoryRefs refs={msg.memories} /> : null}
        <div className="flex gap-0.5 opacity-0 transition-opacity duration-150 group-hover/user:opacity-100 focus-within:opacity-100">
          <CopyButton text={msg.content} />
          {onEdit && !running ? (
            <Tooltip content="编辑后重新发送" side="top">
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-6"
                aria-label="编辑"
                onClick={() => {
                  setDraft(msg.content)
                  setEditing(true)
                }}
              >
                <Pencil />
              </Button>
            </Tooltip>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function SubagentBlock({ msgs, running }: { msgs: ChatMessage[]; running: boolean }) {
  const [open, setOpen] = useState(false)
  const results = useMemo(() => new Map(msgs.filter((m) => m.role === 'tool' && m.toolCallId).map((m) => [m.toolCallId!, m])), [msgs])
  const calls = msgs.flatMap((m) => m.toolCalls ?? [])
  const lastText = [...msgs].reverse().find((m) => m.role === 'assistant' && m.content.trim())?.content
  const active = running && !results.has(calls.at(-1)?.id ?? '')
  return (
    <div className="min-w-0 rounded-md border border-dashed border-border bg-card/50">
      <button onClick={() => setOpen((v) => !v)} className="interactive flex h-8 w-full items-center gap-2 px-2.5 text-left text-xs hover:bg-accent/50">
        <ChevronRight className={cn('size-3 text-subtle-foreground transition-transform duration-150', open && 'rotate-90')} />
        <Bot className="size-3.5 stroke-[1.75] text-muted-foreground" />
        <span className="font-medium">子代理</span>
        <span className="text-muted-foreground">{calls.length} 次工具调用</span>
        {active ? <span className="ml-auto size-1.5 animate-pulse rounded-full bg-brand" /> : null}
      </button>
      {open ? (
        <div className="grid gap-1.5 border-t border-dashed border-border px-2.5 py-2">
          {msgs
            .filter((m) => m.role === 'assistant')
            .map((m) => (
              <AssistantBlock key={m.id} msg={m} results={results} running={running} />
            ))}
        </div>
      ) : lastText ? (
        <p className="line-clamp-2 border-t border-dashed border-border px-3 py-2 text-xs text-muted-foreground">{lastText}</p>
      ) : null}
    </div>
  )
}

export function MessageList({ messages, running, actions }: { messages: ChatMessage[]; running: boolean; actions?: MessageActions }) {
  const results = useMemo(() => new Map(messages.filter((m) => m.role === 'tool' && m.toolCallId && !m.ns).map((m) => [m.toolCallId!, m])), [messages])
  const blocks = useMemo(() => group(messages), [messages])
  const last = messages.at(-1)
  const thinking = running && (!last || last.role === 'user' || (last.role === 'tool' && !last.ns))
  // regenerate belongs to the final answer and re-runs from the user message that led to it
  const lastAssistantIdx = blocks.map((b) => b.kind).lastIndexOf('assistant')
  const lastUser = [...blocks].reverse().find((b): b is Extract<Block, { kind: 'user' }> => b.kind === 'user')

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
      {blocks.map((b, i) =>
        b.kind === 'user' ? (
          <UserBubble key={b.msg.id} msg={b.msg} running={running} onEdit={actions ? (text) => actions.onEdit(b.msg.id, text) : undefined} />
        ) : b.kind === 'assistant' ? (
          <AssistantBlock
            key={b.msg.id}
            msg={b.msg}
            results={results}
            running={running}
            onRegenerate={actions && i === lastAssistantIdx && lastUser ? () => actions.onRegenerate(lastUser.msg.id) : undefined}
          />
        ) : (
          <SubagentBlock key={`sub-${i}`} msgs={b.msgs} running={running} />
        ),
      )}
      {thinking ? (
        <div className="flex animate-fade-in items-center gap-2 text-xs text-muted-foreground">
          <span className="flex gap-1">
            {[0, 1, 2].map((d) => (
              <span key={d} className="size-1 animate-pulse rounded-full bg-muted-foreground" style={{ animationDelay: `${d * 150}ms` }} />
            ))}
          </span>
          思考中
        </div>
      ) : null}
    </div>
  )
}
