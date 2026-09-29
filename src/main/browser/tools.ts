import { tool } from '@langchain/core/tools'
import type { WebContents } from 'electron'
import { z } from 'zod'
import { sessions } from './agent-session'
import { memory } from '../memory/memory-service'
import { browser } from './browser-service'

/** Which tab a set of tools drives. Agent runs get their conversation's tab; the dev sandbox uses the active one. */
export interface ToolCtx {
  tab: () => WebContents
  threadId?: string
  /** Dev sandbox: behave like an agent (dialog/file-chooser takeover) for the duration of a call */
  sandbox?: boolean
}

export const activeTabCtx: ToolCtx = { tab: () => browser.active(), sandbox: true }

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms))
const lastSnap = new Map<number, { url: string; lines: string[] }>()

/** Long URLs (tracking params, data: URLs) would eat the snapshot budget; the model rarely needs more. */
const shortUrl = (u: string) => (u.length > 160 ? `${u.slice(0, 150)}…(${u.length} 字符)` : u)
const header = (wc: WebContents) => `URL: ${shortUrl(wc.getURL())}\n标题: ${wc.getTitle()}`

async function snapshotBody(wc: WebContents, scope?: 'viewport' | 'all'): Promise<string> {
  await browser.waitForLoad(wc, 8000)
  const body = await browser.evalIn<string>(wc, `__agent.snapshot(${JSON.stringify({ scope })})`)
  lastSnap.set(wc.id, { url: wc.getURL(), lines: body.split('\n') })
  return body || '(页面没有可见内容)'
}

async function fullSnapshot(wc: WebContents, scope?: 'viewport' | 'all'): Promise<string> {
  return `${header(wc)}\n\n${await snapshotBody(wc, scope)}`
}

/**
 * What changed since the last snapshot of this tab. Element refs are stable across snapshots,
 * so returning only new/changed lines keeps the context small while staying actionable.
 */
async function changes(wc: WebContents): Promise<string> {
  const prev = lastSnap.get(wc.id)
  const body = await snapshotBody(wc)
  if (!prev || prev.url !== wc.getURL()) return `页面已变化为：\n${header(wc)}\n\n${body}`
  const lines = body.split('\n')
  const [pos, ...rest] = lines
  const prevSet = new Set(prev.lines.slice(1))
  const curSet = new Set(rest)
  const added = rest.filter((l) => !prevSet.has(l))
  const removed = prev.lines.slice(1).filter((l) => !curSet.has(l)).length
  if (!added.length && !removed) return `页面没有可见变化 ${pos}`
  if (added.length > rest.length * 0.6) return `页面内容大幅变化：\n${header(wc)}\n\n${body}`
  const shown = added.join('\n')
  return `页面变化 ${pos}（新增/更新 ${added.length} 行，移除 ${removed} 行）：\n${shown.length > 4000 ? shown.slice(0, 4000) + '\n…' : shown}`
}

function withNotices(wc: WebContents, text: string): string {
  const notes = sessions.takeNotices(wc)
  return notes.length ? `${text}\n\n[页面事件]\n${notes.map((n) => `- ${n}`).join('\n')}` : text
}

/** Runs an action on the conversation's tab with the agent frame + dialog handling in place. */
async function onTab<T>(ctx: ToolCtx, fn: (wc: WebContents) => Promise<T>): Promise<T> {
  const wc = ctx.tab()
  if (ctx.threadId || ctx.sandbox) await sessions.prepare(wc)
  await browser.setControlled(wc, true)
  return fn(wc)
}

const ref = z.string().describe('browser_snapshot 返回的元素引用，例如 "e12"')

export function createBrowserTools(ctx: ToolCtx) {
  const center = (wc: WebContents, r: string) => browser.evalIn<{ x: number; y: number }>(wc, `__agent.center(${JSON.stringify(r)})`)

  return [
    tool(
      async ({ url }) =>
        onTab(ctx, async (wc) => {
          await browser.navigate(url, wc)
          await browser.waitForLoad(wc)
          await settle(300)
          // experience remembered for this site comes along the first time the agent lands on it
          return withNotices(wc, await fullSnapshot(wc)) + memory.siteNotesOnce(ctx.threadId, wc.getURL())
        }),
      {
        name: 'browser_navigate',
        description: '在当前对话的浏览器标签页中打开网址（或搜索关键词），返回页面结构快照。',
        schema: z.object({ url: z.string().describe('完整网址或搜索关键词') }),
      },
    ),
    tool(async ({ scope }) => onTab(ctx, async (wc) => withNotices(wc, await fullSnapshot(wc, scope))), {
      name: 'browser_snapshot',
      description:
        '获取页面结构快照：可交互元素带 [eN] 引用。默认只含正文区域的当前屏和下一屏，导航/页脚链接会折叠；需要完整页面时传 scope:"all"。操作类工具已会返回页面变化，通常无需每步都快照。',
      schema: z.object({ scope: z.enum(['viewport', 'all']).optional() }),
    }),
    tool(
      async ({ ref: r, double }) =>
        onTab(ctx, async (wc) => {
          const { x, y } = await center(wc, r)
          await browser.click(wc, x, y, { clickCount: double ? 2 : 1 })
          await settle(600)
          await browser.waitForLoad(wc, 8000)
          return withNotices(wc, `已点击 ${r}。\n${await changes(wc)}`) + memory.siteNotesOnce(ctx.threadId, wc.getURL())
        }),
      {
        name: 'browser_click',
        description: '点击快照中的元素，返回页面变化。',
        schema: z.object({ ref, double: z.boolean().optional().describe('是否双击') }),
      },
    ),
    tool(
      async ({ ref: r, text, clear, submit }) =>
        onTab(ctx, async (wc) => {
          await browser.evalIn(wc, `__agent.focus(${JSON.stringify(r)}, ${clear !== false})`)
          await browser.insertText(wc, text)
          if (submit) {
            await browser.pressKey(wc, 'Enter')
            await settle(800)
            await browser.waitForLoad(wc)
          }
          return withNotices(wc, `已在 ${r} 输入内容。\n${await changes(wc)}`)
        }),
      {
        name: 'browser_type',
        description: '在输入框中输入文本（默认先清空），可选回车提交，返回页面变化。',
        schema: z.object({
          ref,
          text: z.string(),
          clear: z.boolean().optional().describe('是否先清空，默认 true'),
          submit: z.boolean().optional().describe('输入后是否按回车'),
        }),
      },
    ),
    tool(
      async ({ ref: r, value }) =>
        onTab(ctx, async (wc) => {
          await browser.evalIn(wc, `__agent.setValue(${JSON.stringify(r)}, ${JSON.stringify(value)})`)
          await settle()
          return withNotices(wc, `已选择 "${value}"。\n${await changes(wc)}`)
        }),
      { name: 'browser_select', description: '在下拉框 <select> 中选择选项（按 value 或显示文本）。', schema: z.object({ ref, value: z.string() }) },
    ),
    tool(
      async ({ ref: r }) =>
        onTab(ctx, async (wc) => {
          const { x, y } = await center(wc, r)
          await browser.hover(wc, x, y)
          await settle()
          return withNotices(wc, await changes(wc))
        }),
      { name: 'browser_hover', description: '鼠标悬停到元素上（用于展开菜单等）。', schema: z.object({ ref }) },
    ),
    tool(
      async ({ key }) =>
        onTab(ctx, async (wc) => {
          await browser.pressKey(wc, key)
          await settle(500)
          await browser.waitForLoad(wc, 8000)
          return withNotices(wc, await changes(wc))
        }),
      {
        name: 'browser_press_key',
        description: '按下键盘按键，例如 Enter、Tab、Escape、ArrowDown、PageDown 或单个字符。',
        schema: z.object({ key: z.string() }),
      },
    ),
    tool(
      async ({ direction, amount }) =>
        onTab(ctx, async (wc) => {
          const px = amount ?? 700
          await browser.scroll(wc, 0, direction === 'up' ? -px : px)
          await settle()
          return withNotices(wc, await changes(wc))
        }),
      {
        name: 'browser_scroll',
        description: '滚动页面，返回新出现的内容。',
        schema: z.object({ direction: z.enum(['up', 'down']), amount: z.number().optional().describe('像素，默认 700') }),
      },
    ),
    tool(
      async ({ text, selector, timeoutMs }) =>
        onTab(ctx, async (wc) => {
          const deadline = Date.now() + (timeoutMs ?? 10000)
          while (Date.now() < deadline) {
            const found = await browser.evalIn<boolean>(
              wc,
              selector ? `!!__agent.query([${JSON.stringify(selector)}])` : `document.body && document.body.innerText.includes(${JSON.stringify(text ?? '')})`,
            )
            if (found) return withNotices(wc, `已出现。\n${await changes(wc)}`)
            await settle(400)
          }
          return withNotices(wc, '等待超时，目标未出现。')
        }),
      {
        name: 'browser_wait_for',
        description: '等待页面出现指定文本或 CSS 选择器。',
        schema: z.object({ text: z.string().optional(), selector: z.string().optional(), timeoutMs: z.number().optional() }),
      },
    ),
    tool(
      async ({ fullPage }) =>
        onTab(ctx, async (wc) => {
          // hidden views don't paint: bring the conversation's tab to the front first
          const active = browser.active()
          if (active.id !== wc.id) browser.activate(wc.id)
          const data = await Promise.race([
            browser.screenshot(wc, fullPage),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('截图超时：标签页可能不可见，请先打开浏览器面板')), 8000)),
          ])
          return [
            { type: 'text', text: withNotices(wc, header(wc)) },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } },
          ]
        }),
      { name: 'browser_screenshot', description: '截取当前页面截图（需要支持视觉的模型）。', schema: z.object({ fullPage: z.boolean().optional() }) },
    ),
    tool(
      async ({ selector }) =>
        onTab(ctx, async (wc) => {
          const text = await browser.evalIn<string>(wc, `__agent.extract(${JSON.stringify(selector ?? null)} || undefined)`)
          return withNotices(wc, `${header(wc)}\n\n${text}`)
        }),
      {
        name: 'browser_extract',
        description: '提取页面（或选择器范围内）的可读文本，用于阅读文章、表格、搜索结果等。比反复快照更省。',
        schema: z.object({ selector: z.string().optional() }),
      },
    ),
    tool(
      async ({ script }) =>
        onTab(ctx, async (wc) => {
          const result = await wc.executeJavaScript(`(async () => { ${script} })()`, true)
          return withNotices(wc, JSON.stringify(result ?? null, null, 2).slice(0, 20000))
        }),
      {
        name: 'browser_eval',
        description: '在页面主环境执行 JavaScript（函数体，需 return 结果）。仅在其他工具无法完成时使用。',
        schema: z.object({ script: z.string() }),
      },
    ),
    tool(
      async ({ action, tabId, url }) => {
        switch (action) {
          case 'new': {
            const id = browser.newTab(url)
            if (ctx.threadId) sessions.assign(ctx.threadId, id)
            await settle(800)
            return `已新建并切换到标签页 ${id}。\n${await fullSnapshot(browser.tab(id)!)}`
          }
          case 'switch': {
            if (tabId == null || !browser.tab(tabId)) return '需要有效的 tabId'
            if (ctx.threadId) sessions.assign(ctx.threadId, tabId)
            browser.activate(tabId)
            return fullSnapshot(browser.tab(tabId)!)
          }
          case 'close':
            if (tabId == null) return '需要 tabId'
            browser.closeTab(tabId)
            return `已关闭 ${tabId}`
          default: {
            const mine = ctx.tab().id
            return JSON.stringify(browser.state().tabs.map(({ id, url: u, title }) => ({ id, url: u, title, current: id === mine })))
          }
        }
      },
      {
        name: 'browser_tabs',
        description: '管理浏览器标签页：list / new / switch / close。new 和 switch 会让本对话后续操作该标签页。',
        schema: z.object({ action: z.enum(['list', 'new', 'switch', 'close']), tabId: z.number().optional(), url: z.string().optional() }),
      },
    ),
    tool(
      async ({ action }) =>
        onTab(ctx, async (wc) => {
          const h = wc.navigationHistory
          if (action === 'back' ? !h.canGoBack() : !h.canGoForward()) return '无法' + (action === 'back' ? '后退' : '前进')
          if (action === 'back') h.goBack()
          else h.goForward()
          await settle(800)
          await browser.waitForLoad(wc)
          return withNotices(wc, await fullSnapshot(wc))
        }),
      { name: 'browser_history', description: '浏览器后退或前进。', schema: z.object({ action: z.enum(['back', 'forward']) }) },
    ),
    tool(
      async ({ ref: r, files }) =>
        onTab(ctx, async (wc) => {
          const pending = sessions.chooser(wc)
          if (pending) {
            await browser.cdp(wc, 'DOM.setFileInputFiles', { files, backendNodeId: pending.backendNodeId })
            sessions.clearChooser(wc)
          } else {
            if (!r) return '当前没有打开的文件选择框，请提供文件输入框的 ref'
            const { x, y } = await center(wc, r)
            await browser.cdp(wc, 'DOM.getDocument')
            const { backendNodeId } = await browser.cdp<{ backendNodeId: number }>(wc, 'DOM.getNodeForLocation', { x, y })
            await browser.cdp(wc, 'DOM.setFileInputFiles', { backendNodeId, files })
          }
          await settle()
          return withNotices(wc, `已选择 ${files.length} 个文件。\n${await changes(wc)}`)
        }),
      {
        name: 'browser_upload_file',
        description: '上传本地文件（绝对路径）。若页面已打开文件选择框则直接使用；否则需提供文件输入框的 ref。',
        schema: z.object({ ref: ref.optional(), files: z.array(z.string()).min(1) }),
      },
    ),
    tool(
      async ({ confirm, promptText }) =>
        onTab(ctx, async (wc) => {
          await sessions.setPolicy(wc, { confirm, prompt: promptText ?? null })
          return `已设置：确认框将${confirm ? '自动点「确定」' : '自动点「取消」'}${promptText != null ? `，输入框将填写「${promptText}」` : ''}。请重试刚才的操作。`
        }),
      {
        name: 'browser_set_dialog_policy',
        description: '设置页面弹出确认框/输入框时的自动应答。默认确认框点「取消」。只有在确定用户意图（如确实要删除/提交）时才设为确定。',
        schema: z.object({ confirm: z.boolean(), promptText: z.string().optional() }),
      },
    ),
    tool(
      async () =>
        JSON.stringify(
          browser.downloads.slice(0, 10).map(({ filename, path, state, received, total }) => ({ filename, path, state, received, total })),
          null,
          2,
        ),
      { name: 'browser_downloads', description: '列出最近的下载（文件会自动保存到下载文件夹）。', schema: z.object({}) },
    ),
  ]
}
