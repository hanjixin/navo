import { Activity, ChevronRight, Code2, Play, ScrollText, Trash2, Wrench } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Page, PageHeader } from '@/components/layout/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input, Textarea } from '@/components/ui/input'
import { AsyncView, EmptyState, ErrorState, ListSkeleton } from '@/components/ui/states'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAsync } from '@/hooks/use-async'
import { call, on } from '@/lib/ipc'
import { cn, errorMessage, timeAgo } from '@/lib/utils'
import { useSettings } from '@/stores/settings'

function Traces() {
  const traces = useAsync(() => call('dev.traces'))
  const [open, setOpen] = useState<string | null>(null)
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs text-muted-foreground">最近 500 条模型与工具调用（仅在开发者模式下记录）</p>
        <div className="flex gap-1.5">
          <Button variant="ghost" size="sm" onClick={traces.reload}>
            刷新
          </Button>
          <Button variant="ghost" size="sm" onClick={async () => (await call('dev.clearTraces'), traces.reload())}>
            <Trash2 />
            清空
          </Button>
        </div>
      </div>
      <AsyncView
        state={traces}
        loading={<ListSkeleton rows={4} />}
        empty={<EmptyState icon={Activity} title="暂无运行轨迹" description="在对话中运行 Agent 后，这里会记录每次模型调用与工具调用。" />}
      >
        {(list) => (
          <Card className="divide-y divide-border">
            {list.map((t) => (
              <div key={t.id}>
                <button
                  onClick={() => setOpen(open === t.id ? null : t.id)}
                  className="interactive flex h-10 w-full items-center gap-3 px-4 text-left text-sm hover:bg-accent/50"
                >
                  <ChevronRight className={cn('size-3.5 text-subtle-foreground transition-transform duration-150', open === t.id && 'rotate-90')} />
                  <Badge variant={t.kind === 'llm' ? 'primary' : t.kind === 'error' ? 'danger' : 'neutral'} className="w-12 justify-center">
                    {t.kind === 'llm' ? 'LLM' : t.kind === 'tool' ? '工具' : '错误'}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{t.name}</span>
                  {t.tokens ? <span className="text-xs text-muted-foreground">{t.tokens} tok</span> : null}
                  <span className="w-16 text-right font-mono text-xs text-muted-foreground">{t.durationMs} ms</span>
                  <span className="w-20 text-right text-xs text-subtle-foreground">{timeAgo(t.createdAt)}</span>
                </button>
                {open === t.id ? (
                  <div className="grid animate-fade-in grid-cols-2 gap-3 border-t border-border bg-background/50 px-4 py-3">
                    {[
                      ['输入', t.input],
                      ['输出', t.output],
                    ].map(([label, text]) => (
                      <div key={label} className="min-w-0">
                        <div className="mb-1 text-[11px] font-medium text-subtle-foreground">{label}</div>
                        <pre className="selectable max-h-80 overflow-auto rounded-md bg-muted px-2.5 py-2 font-mono text-[11.5px] whitespace-pre-wrap">
                          {text}
                        </pre>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </Card>
        )}
      </AsyncView>
    </div>
  )
}

function ToolSandbox() {
  const tools = useAsync(() => call('dev.tools'))
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [args, setArgs] = useState('{}')
  const [out, setOut] = useState<{ ok: boolean; text: string } | null>(null)
  const [running, setRunning] = useState(false)
  const tool = tools.data?.find((t) => t.name === selected)
  const filtered = useMemo(() => (tools.data ?? []).filter((t) => t.name.includes(q)), [tools.data, q])

  const pick = (name: string) => {
    setSelected(name)
    setOut(null)
    const t = tools.data?.find((x) => x.name === name)
    const props = (t?.schema as { properties?: Record<string, unknown> })?.properties ?? {}
    setArgs(JSON.stringify(Object.fromEntries(Object.keys(props).map((k) => [k, ''])), null, 2))
  }

  const invoke = async () => {
    if (!selected) return
    setRunning(true)
    try {
      const r = await call('dev.invokeTool', selected, JSON.parse(args))
      setOut({ ok: true, text: typeof r === 'string' ? r : JSON.stringify(r, null, 2) })
    } catch (e) {
      setOut({ ok: false, text: errorMessage(e) })
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="grid grid-cols-[280px_1fr] gap-4">
      <div>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="筛选工具" className="mb-2 h-7 text-xs" />
        <AsyncView state={tools} loading={<ListSkeleton rows={5} />}>
          {() => (
            <div className="grid max-h-[560px] gap-px overflow-y-auto">
              {filtered.map((t) => (
                <button
                  key={t.name}
                  onClick={() => pick(t.name)}
                  className={cn(
                    'interactive flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left',
                    selected === t.name ? 'bg-accent' : 'hover:bg-accent/60',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{t.name}</span>
                  <Badge variant="outline">{t.source}</Badge>
                </button>
              ))}
            </div>
          )}
        </AsyncView>
      </div>
      <div>
        {tool ? (
          <Card className="p-4">
            <div className="font-mono text-sm font-medium">{tool.name}</div>
            <p className="mt-1 text-xs text-muted-foreground">{tool.description}</p>
            <div className="mt-4 mb-1 text-[11px] font-medium text-subtle-foreground">参数 (JSON)</div>
            <Textarea value={args} onChange={(e) => setArgs(e.target.value)} rows={6} className="font-mono text-xs" />
            <div className="mt-3 flex justify-end">
              <Button variant="primary" size="sm" loading={running} onClick={invoke}>
                {!running ? <Play /> : null}
                调用
              </Button>
            </div>
            {out ? (
              out.ok ? (
                <pre className="selectable mt-3 max-h-96 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap">{out.text}</pre>
              ) : (
                <ErrorState error={out.text} compact className="mt-3" />
              )
            ) : null}
            <details className="mt-4">
              <summary className="cursor-pointer text-xs text-muted-foreground">JSON Schema</summary>
              <pre className="selectable mt-2 max-h-64 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-[11px]">
                {JSON.stringify(tool.schema, null, 2)}
              </pre>
            </details>
          </Card>
        ) : (
          <EmptyState icon={Wrench} title="选择一个工具" description="直接调用工具以调试浏览器、插件、宏与 MCP 工具，无需经过模型。" />
        )}
      </div>
    </div>
  )
}

function Logs() {
  const [lines, setLines] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    call('dev.logs').then(setLines, (e) => setError(errorMessage(e)))
    return on('dev.log', (l) => setLines((prev) => [...(prev ?? []), l].slice(-2000)))
  }, [])
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [lines])
  if (error) return <ErrorState error={error} />
  if (!lines) return <ListSkeleton rows={3} />
  return (
    <pre ref={ref} className="selectable h-[560px] overflow-auto rounded-lg border border-border bg-card p-3 font-mono text-[11.5px] leading-5">
      {lines.length
        ? lines.map((l, i) => (
            <div key={i} className={cn(l.includes('ERROR') ? 'text-danger' : l.includes('WARN') ? 'text-warning' : 'text-muted-foreground')}>
              {l}
            </div>
          ))
        : '暂无日志'}
    </pre>
  )
}

export function DevPage() {
  const devMode = useSettings((s) => s.settings?.devMode)
  if (devMode === false) {
    return (
      <Page>
        <EmptyState icon={Code2} title="开发者模式未开启" description="在「设置」中开启开发者模式后可查看运行轨迹、日志并调试工具。" />
      </Page>
    )
  }
  return (
    <Page wide>
      <PageHeader title="开发者" description="调试 Agent 的运行过程、工具与日志。" />
      <Tabs defaultValue="traces">
        <TabsList className="mb-4 w-full">
          <TabsTrigger value="traces">
            <Activity />
            运行轨迹
          </TabsTrigger>
          <TabsTrigger value="tools">
            <Wrench />
            工具沙盒
          </TabsTrigger>
          <TabsTrigger value="logs">
            <ScrollText />
            日志
          </TabsTrigger>
        </TabsList>
        <TabsContent value="traces">
          <Traces />
        </TabsContent>
        <TabsContent value="tools">
          <ToolSandbox />
        </TabsContent>
        <TabsContent value="logs">
          <Logs />
        </TabsContent>
      </Tabs>
    </Page>
  )
}
