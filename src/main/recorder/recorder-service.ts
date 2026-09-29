import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { ipcMain, type WebContents } from 'electron'
import { z } from 'zod'
import type { Macro, MacroRunResult, MacroStep } from '@shared/types'
import { db } from '../core/db'
import { newId } from '../core/id'
import { emit } from '../core/ipc'
import { log } from '../core/logger'
import { browser } from '../browser/browser-service'
import { skills } from '../skills/skill-service'
import { recorderScript } from './recorder-script'
import { appendEvent, fillTemplate, placeholders, type RawEvent } from './steps'

const RECORDER_SRC = `(${recorderScript.toString()})();`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class RecorderService {
  private steps: MacroStep[] = []
  private startUrl = ''
  private lastActionAt = 0
  private onNavigate = (_e: unknown, url: string) => this.push({ type: 'navigate', url, t: Date.now() })
  private recordingTab: WebContents | null = null

  init(): void {
    ipcMain.on('tab:recorder', (e, raw: RawEvent) => {
      if (!browser.recording || e.sender !== this.recordingTab) return
      this.push(raw)
    })
    browser.onDomReady(async (wc) => {
      if (browser.recording && wc === this.recordingTab) await this.injectRecorder(wc)
    })
  }

  private push(raw: RawEvent): void {
    if (raw.type !== 'navigate') this.lastActionAt = raw.t
    this.steps = appendEvent(this.steps, raw, this.lastActionAt)
    emit('macros.recording', { steps: this.steps.length, last: this.steps.at(-1)?.label })
  }

  private async injectRecorder(wc: WebContents): Promise<void> {
    await browser.evalIn(wc, `(() => { ${RECORDER_SRC} return true })()`).catch((err) => log.warn(`[recorder] inject failed: ${err.message}`))
  }

  // ---------- storage ----------
  list(): Macro[] {
    return (db().prepare('SELECT data FROM macros ORDER BY updated_at DESC').all() as { data: string }[]).map((r) => JSON.parse(r.data) as Macro)
  }

  get(id: string): Macro {
    const r = db().prepare('SELECT data FROM macros WHERE id = ?').get(id) as { data: string } | undefined
    if (!r) throw new Error('宏不存在')
    return JSON.parse(r.data) as Macro
  }

  save(macro: Macro): Macro {
    const m = { ...macro, updatedAt: Date.now() }
    // keep params in sync with {{placeholders}} used in steps
    const names = placeholders(m.steps)
    m.params = [...m.params.filter((p) => names.includes(p.name)), ...names.filter((n) => !m.params.some((p) => p.name === n)).map((name) => ({ name }))]
    db()
      .prepare('INSERT INTO macros(id, data, updated_at) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
      .run(m.id, JSON.stringify(m), m.updatedAt)
    return m
  }

  delete(id: string): void {
    db().prepare('DELETE FROM macros WHERE id = ?').run(id)
  }

  // ---------- recording ----------
  async start(): Promise<void> {
    if (browser.recording) return
    const wc = browser.active()
    this.recordingTab = wc
    this.steps = []
    this.lastActionAt = 0
    this.startUrl = wc.getURL()
    browser.recording = true
    wc.on('did-navigate', this.onNavigate)
    await this.injectRecorder(wc)
    browser.changed()
    emit('macros.recording', { steps: 0 })
  }

  async stop(): Promise<Macro | null> {
    if (!browser.recording) return null
    browser.recording = false
    const wc = this.recordingTab
    this.recordingTab = null
    if (wc && !wc.isDestroyed()) {
      wc.removeListener('did-navigate', this.onNavigate)
      await browser.evalIn(wc, 'window.__agentRecorder && __agentRecorder.stop()').catch(() => undefined)
    }
    browser.changed()
    if (!this.steps.length) return null
    const now = Date.now()
    return this.save({
      id: newId(),
      name: `录制宏 ${new Date(now).toLocaleString('zh-CN', { hour12: false })}`,
      description: '',
      startUrl: this.startUrl,
      params: [],
      steps: this.steps,
      exposeAsTool: false,
      createdAt: now,
      updatedAt: now,
    })
  }

  // ---------- playback ----------
  private async find(wc: WebContents, selectors: string[], timeout: number): Promise<string> {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const ref = await browser.evalIn<string | null>(
        wc,
        `(() => { const el = __agent.query(${JSON.stringify(selectors)}); return el ? __agent.refFor(el) : null })()`,
      )
      if (ref) return ref
      await sleep(300)
    }
    throw new Error(`未找到元素: ${selectors[0] ?? '(无选择器)'}`)
  }

  /** Plays a macro on `wc` (the active tab by default). Agent runs pass their own tab and keep control afterwards. */
  async run(id: string, params: Record<string, string> = {}, wc: WebContents = browser.active(), release = true): Promise<MacroRunResult> {
    const macro = this.get(id)
    const values = Object.fromEntries(macro.params.map((p) => [p.name, params[p.name] ?? p.default ?? '']))
    const extracted: Record<string, string> = {}
    await browser.setControlled(wc, true)
    try {
      if (macro.startUrl) {
        await browser.navigate(macro.startUrl, wc)
        await browser.waitForLoad(wc)
      }
      for (let i = 0; i < macro.steps.length; i++) {
        const s = macro.steps[i]
        const timeout = s.timeout ?? 10000
        try {
          await this.runStep(wc, s, values, extracted, timeout)
        } catch (err) {
          return { ok: false, failedStep: i, error: (err as Error).message, extracted }
        }
        await sleep(250)
      }
      return { ok: true, extracted }
    } finally {
      if (release) await browser.setControlled(wc, false)
    }
  }

  private async runStep(wc: WebContents, s: MacroStep, values: Record<string, string>, extracted: Record<string, string>, timeout: number): Promise<void> {
    switch (s.type) {
      case 'navigate':
        await browser.navigate(fillTemplate(s.url, values), wc)
        await browser.waitForLoad(wc)
        return
      case 'click': {
        const ref = await this.find(wc, s.selectors ?? [], timeout)
        const { x, y } = await browser.evalIn<{ x: number; y: number }>(wc, `__agent.center(${JSON.stringify(ref)})`)
        await browser.click(wc, x, y)
        await sleep(300)
        await browser.waitForLoad(wc)
        return
      }
      case 'type': {
        const ref = await this.find(wc, s.selectors ?? [], timeout)
        await browser.evalIn(wc, `__agent.focus(${JSON.stringify(ref)}, true)`)
        await browser.insertText(wc, fillTemplate(s.value, values))
        return
      }
      case 'select': {
        const ref = await this.find(wc, s.selectors ?? [], timeout)
        await browser.evalIn(wc, `__agent.setValue(${JSON.stringify(ref)}, ${JSON.stringify(fillTemplate(s.value, values))})`)
        return
      }
      case 'press':
        if (s.selectors?.length) {
          const ref = await this.find(wc, s.selectors, timeout).catch(() => null)
          if (ref) await browser.evalIn(wc, `__agent.focus(${JSON.stringify(ref)}, false)`)
        }
        await browser.pressKey(wc, s.key ?? 'Enter')
        await sleep(400)
        await browser.waitForLoad(wc)
        return
      case 'wait':
        if (s.selectors?.length) await this.find(wc, s.selectors, timeout)
        else await sleep(Number(s.value) || 1000)
        return
      case 'scroll':
        await browser.scroll(wc, 0, Number(s.value) || 600)
        return
      case 'extract': {
        const text = await browser.evalIn<string>(wc, `__agent.extract(${JSON.stringify(s.selectors?.[0] ?? null)} || undefined)`)
        extracted[s.label || `step_${s.id}`] = text
        return
      }
    }
  }

  // ---------- agent integration ----------
  tools(getTab: () => WebContents = () => browser.active()): StructuredToolInterface[] {
    return this.list()
      .filter((m) => m.exposeAsTool)
      .map((m) => {
        const shape = Object.fromEntries(
          m.params.map((p) => [
            p.name,
            z
              .string()
              .optional()
              .describe(p.description || `默认: ${p.default ?? ''}`),
          ]),
        )
        return tool(
          async (args: Record<string, string | undefined>) => {
            const res = await this.run(m.id, Object.fromEntries(Object.entries(args).filter(([, v]) => v != null)) as Record<string, string>, getTab(), false)
            if (!res.ok) return `宏执行失败（第 ${(res.failedStep ?? 0) + 1} 步）: ${res.error}。可以改用 browser_* 工具手动完成剩余步骤。`
            return `宏执行成功。${Object.keys(res.extracted).length ? '\n提取结果:\n' + JSON.stringify(res.extracted, null, 2) : ''}`
          },
          {
            name: `macro_${slug(m.name) || m.id.slice(0, 8)}`.slice(0, 64),
            description: `[录制宏] ${m.name}${m.description ? '：' + m.description : ''}`,
            schema: z.object(shape),
          },
        )
      }) as StructuredToolInterface[]
  }

  toSkill(id: string): string {
    const m = this.get(id)
    const name = slug(m.name).replace(/_/g, '-') || `macro-${m.id.slice(0, 8)}`
    const lines = m.steps.map((s, i) => {
      const what =
        s.type === 'navigate'
          ? `打开 ${s.url}`
          : s.type === 'click'
            ? `点击 ${s.label ?? ''}`
            : s.type === 'type'
              ? `在 ${s.label ?? ''} 输入 \`${s.value ?? ''}\``
              : s.type === 'select'
                ? `在 ${s.label ?? ''} 选择 \`${s.value ?? ''}\``
                : s.type === 'press'
                  ? `按 ${s.key}`
                  : s.type === 'wait'
                    ? `等待 ${s.selectors?.[0] ?? s.value + 'ms'}`
                    : s.type === 'scroll'
                      ? '向下滚动'
                      : `提取 ${s.selectors?.[0] ?? '页面'} 的文本`
      return `${i + 1}. ${what}${s.selectors?.length ? `（选择器: \`${s.selectors[0]}\`）` : ''}`
    })
    const md = `---
name: ${name}
description: ${(m.description || m.name).replace(/\n/g, ' ')}
---

# ${m.name}

${m.description}

起始页面: ${m.startUrl ?? '当前页'}

${m.params.length ? `## 参数\n${m.params.map((p) => `- \`${p.name}\`${p.description ? '：' + p.description : ''}${p.default ? `（默认 ${p.default}）` : ''}`).join('\n')}\n` : ''}
## 步骤
使用 browser_* 工具依次执行。每步前先用 browser_snapshot 定位元素，选择器仅作参考；若页面结构有变化，按步骤意图灵活处理。

${lines.join('\n')}
`
    skills.save(name, md)
    return name
  }
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
}

export const recorder = new RecorderService()
