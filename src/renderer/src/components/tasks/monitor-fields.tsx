import { Eye, Globe } from 'lucide-react'
import { useState } from 'react'
import type { MonitorConfig } from '@shared/types'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { useAsync } from '@/hooks/use-async'
import { call } from '@/lib/ipc'
import { errorMessage } from '@/lib/utils'
import { useBrowser } from '@/stores/browser'

/** The monitor part of the task dialog: which page, what to look at, when to alert, what then. */
export function MonitorFields({ value, onChange }: { value: MonitorConfig; onChange: (v: MonitorConfig) => void }) {
  const current = useBrowser((s) => s.state.tabs.find((t) => t.active)?.url)
  const [preview, setPreview] = useState<{ loading: boolean; text?: string; error?: string } | null>(null)
  const set = (patch: Partial<MonitorConfig>) => onChange({ ...value, ...patch })
  // connected group bots and mailboxes can receive the alert too
  const targets = useAsync(async () => {
    const [catalog, states] = await Promise.all([call('connectors.catalog'), call('connectors.states')])
    const on = new Set(states.filter((s) => s.connected && s.enabled).map((s) => s.id))
    return catalog.filter((d) => d.canNotify && on.has(d.id))
  }, [])
  const canUseCurrent = !!current && /^https?:/.test(current) && current !== value.url

  const tryRead = async () => {
    setPreview({ loading: true })
    try {
      const r = await call('monitor.preview', value.url.trim(), value.selector?.trim() || null)
      setPreview({ loading: false, text: r.text })
    } catch (e) {
      setPreview({ loading: false, error: errorMessage(e) })
    }
  }

  return (
    <div className="grid gap-4">
      <Field label="网址">
        <div className="flex gap-2">
          <Input value={value.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://…" className="min-w-0 flex-1" />
          {canUseCurrent ? (
            <Button variant="secondary" size="sm" className="h-9 shrink-0" onClick={() => set({ url: current })}>
              <Globe />
              用当前页面
            </Button>
          ) : null}
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="关注的内容" hint="用一句话说明，帮助判断哪些变化有关">
          <Input value={value.focus ?? ''} onChange={(e) => set({ focus: e.target.value })} placeholder="商品价格、公告列表…" />
        </Field>
        <Field label="页面区域（可选）" hint="CSS 选择器；留空则读取正文">
          <Input value={value.selector ?? ''} onChange={(e) => set({ selector: e.target.value })} placeholder=".price" className="font-mono" />
        </Field>
      </div>
      <div className="grid gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="justify-self-start"
          loading={preview?.loading}
          disabled={!/^https?:\/\/\S+$/i.test(value.url.trim())}
          onClick={() => void tryRead()}
        >
          {!preview?.loading ? <Eye /> : null}
          试读一下
        </Button>
        {preview && !preview.loading ? (
          <pre
            data-testid="monitor-preview"
            className={
              preview.error
                ? 'rounded-md border border-l-2 border-border border-l-danger bg-danger-soft px-3 py-2 text-xs whitespace-pre-wrap text-danger'
                : 'selectable max-h-32 overflow-auto rounded-md border border-border bg-muted px-3 py-2 font-sans text-xs whitespace-pre-wrap text-muted-foreground'
            }
          >
            {preview.error ?? `${preview.text!.slice(0, 1200)}${preview.text!.length > 1200 ? '\n…' : ''}`}
          </pre>
        ) : null}
      </div>
      <Field label="触发条件" hint="留空则内容有实质变化就提醒；时间、广告这类无关变化不会打扰你">
        <Textarea
          value={value.condition ?? ''}
          onChange={(e) => set({ condition: e.target.value })}
          rows={2}
          placeholder="价格低于 1500 元；或：出现新的公告"
        />
      </Field>
      <Field label="触发后">
        <Select
          value={value.action}
          onChange={(v) => set({ action: v as MonitorConfig['action'] })}
          options={[
            { value: 'notify', label: '发送系统通知' },
            { value: 'agent', label: '发送通知，并让 Agent 执行一项任务' },
          ]}
        />
      </Field>
      <Field
        label="同时发到"
        hint={targets.data?.length ? '群机器人发到群里；邮箱发给你自己' : '在「连接器」里连接企业微信 / 钉钉 / 飞书群机器人或邮箱后，可以把提醒发到那里'}
      >
        <Select
          value={value.notifyConnector ?? 'none'}
          onChange={(v) => set({ notifyConnector: v === 'none' ? null : v })}
          options={[{ value: 'none', label: '只发系统通知' }, ...(targets.data ?? []).map((d) => ({ value: d.id, label: d.name }))]}
        />
      </Field>
      {value.action === 'agent' ? (
        <Field label="让 Agent 做什么" hint="触发原因和网址会一并告诉 Agent">
          <Textarea
            value={value.prompt ?? ''}
            onChange={(e) => set({ prompt: e.target.value })}
            rows={3}
            placeholder="打开这个页面，把新公告的标题和要点整理成一段摘要"
          />
        </Field>
      ) : null}
    </div>
  )
}
