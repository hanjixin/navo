import { tool } from '@langchain/core/tools'
import type { WebContents } from 'electron'
import { z } from 'zod'
import { sessions } from './agent-session'
import { trace } from '../flows/trace'
import { memory } from '../memory/memory-service'
import { browser } from './browser-service'
import { builtinDriver, type PageDriver } from './page-driver'
import { t } from '@shared/i18n'

/** Which tab a set of tools drives. Agent runs get their conversation's tab; the dev sandbox uses the active one. */
export interface ToolCtx {
  tab: () => WebContents
  /** the page the tools drive; defaults to `tab` in the built-in browser */
  page?: () => PageDriver
  threadId?: string
  /** Dev sandbox: behave like an agent (dialog/file-chooser takeover) for the duration of a call */
  sandbox?: boolean
}

/** The page a set of tools drives right now. */
export function pageOf(ctx: ToolCtx): PageDriver {
  return ctx.page ? ctx.page() : builtinDriver(ctx.tab(), { agent: !!(ctx.threadId || ctx.sandbox) })
}

export const activeTabCtx: ToolCtx = { tab: () => browser.active(), sandbox: true }

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms))
const lastSnap = new Map<string, { url: string; lines: string[] }>()

/** Long URLs (tracking params, data: URLs) would eat the snapshot budget; the model rarely needs more. */
const shortUrl = (u: string) => (u.length > 160 ? `${u.slice(0, 150)}…(${u.length} 字符)` : u)
const header = (p: PageDriver) => `URL: ${shortUrl(p.url())}\n标题: ${p.title()}`

async function snapshotBody(p: PageDriver, scope?: 'viewport' | 'all'): Promise<string> {
  await p.waitForLoad(8000)
  const body = await p.evalIn<string>(`__agent.snapshot(${JSON.stringify({ scope })})`)
  lastSnap.set(p.id, { url: p.url(), lines: body.split('\n') })
  return body || '(页面没有可见内容)'
}

export async function fullSnapshot(p: PageDriver, scope?: 'viewport' | 'all'): Promise<string> {
  return `${header(p)}\n\n${await snapshotBody(p, scope)}`
}

/**
 * What changed since the last snapshot of this tab. Element refs are stable across snapshots,
 * so returning only new/changed lines keeps the context small while staying actionable.
 */
async function changes(p: PageDriver): Promise<string> {
  const prev = lastSnap.get(p.id)
  const body = await snapshotBody(p)
  if (!prev || prev.url !== p.url()) return `页面已变化为：\n${header(p)}\n\n${body}`
  const lines = body.split('\n')
  const [pos, ...rest] = lines
  const prevSet = new Set(prev.lines.slice(1))
  const curSet = new Set(rest)
  const added = rest.filter((l) => !prevSet.has(l))
  const removed = prev.lines.slice(1).filter((l) => !curSet.has(l)).length
  if (!added.length && !removed) return `页面没有可见变化 ${pos}`
  if (added.length > rest.length * 0.6) return `页面内容大幅变化：\n${header(p)}\n\n${body}`
  const shown = added.join('\n')
  return `页面变化 ${pos}（新增/更新 ${added.length} 行，移除 ${removed} 行）：\n${shown.length > 4000 ? shown.slice(0, 4000) + '\n…' : shown}`
}

/** The element behind a ref, as a replayable target (selectors computed before acting: a click may remove it). */
async function targetOf(p: PageDriver, ref: string): Promise<{ selectors: string[]; label: string; secret: boolean }> {
  const r = JSON.stringify(ref)
  try {
    return await p.evalIn(`({ selectors: __agent.selectorsOf(${r}), label: __agent.nameOf(__agent.resolve(${r})), secret: __agent.isSecret(${r}) })`)
  } catch {
    return { selectors: [], label: '', secret: false }
  }
}

function withNotices(p: PageDriver, text: string): string {
  const notes = p.takeNotices()
  return notes.length ? `${text}\n\n[页面事件]\n${notes.map((n) => `- ${n}`).join('\n')}` : text
}

/** Runs an action on the conversation's page with the agent frame + dialog handling in place. */
async function onPage<T>(ctx: ToolCtx, fn: (p: PageDriver) => Promise<T>): Promise<T> {
  const p = pageOf(ctx)
  await p.prepare()
  return fn(p)
}

/** Steps for turning a run into a fixed flow: fixed flows replay in the built-in browser only. */
function traced(ctx: ToolCtx, p: PageDriver, step: Parameters<typeof trace.add>[1]): void {
  if (p.kind === 'builtin') trace.add(ctx.threadId, step)
}

const ref = z.string().describe('browser_snapshot 返回的元素引用，例如 "e12"')

export function createBrowserTools(ctx: ToolCtx) {
  const center = (p: PageDriver, r: string) => p.evalIn<{ x: number; y: number }>(`__agent.center(${JSON.stringify(r)})`)

  return [
    tool(
      async ({ url }) =>
        onPage(ctx, async (p) => {
          await p.navigate(url)
          await p.waitForLoad()
          await settle(300)
          traced(ctx, p, { type: 'navigate', url: p.url() })
          // experience remembered for this site comes along the first time the agent lands on it
          return withNotices(p, await fullSnapshot(p)) + memory.siteNotesOnce(ctx.threadId, p.url())
        }),
      {
        name: 'browser_navigate',
        description: '在当前对话的浏览器标签页中打开网址（或搜索关键词），返回页面结构快照。',
        schema: z.object({ url: z.string().describe('完整网址或搜索关键词') }),
      },
    ),
    tool(async ({ scope }) => onPage(ctx, async (p) => withNotices(p, await fullSnapshot(p, scope))), {
      name: 'browser_snapshot',
      description:
        '获取页面结构快照：可交互元素带 [eN] 引用。默认只含正文区域的当前屏和下一屏，导航/页脚链接会折叠；需要完整页面时传 scope:"all"。操作类工具已会返回页面变化，通常无需每步都快照。',
      schema: z.object({ scope: z.enum(['viewport', 'all']).optional() }),
    }),
    tool(
      async ({ ref: r, double }) =>
        onPage(ctx, async (p) => {
          const target = await targetOf(p, r)
          const at = p.url()
          await browser.clickRef(p, r, { double })
          traced(ctx, p, { type: 'click', selectors: target.selectors, label: target.label, url: at })
          await settle(600)
          await p.waitForLoad(8000)
          return withNotices(p, `已点击 ${r}。\n${await changes(p)}`) + memory.siteNotesOnce(ctx.threadId, p.url())
        }),
      {
        name: 'browser_click',
        description: '点击快照中的元素，返回页面变化。',
        schema: z.object({ ref, double: z.boolean().optional().describe('是否双击') }),
      },
    ),
    tool(
      async ({ ref: r, text, clear, submit }) =>
        onPage(ctx, async (p) => {
          const target = await targetOf(p, r)
          const at = p.url()
          await browser.typeRef(p, r, text, clear !== false)
          traced(ctx, p, { type: 'type', selectors: target.selectors, label: target.label, value: text, secret: target.secret, url: at })
          if (submit) traced(ctx, p, { type: 'press', key: 'Enter', selectors: target.selectors, url: at })
          if (submit) {
            await browser.submitRef(p, r)
            await settle(800)
            await p.waitForLoad()
          }
          return withNotices(p, `已在 ${r} 输入内容。\n${await changes(p)}`)
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
        onPage(ctx, async (p) => {
          const target = await targetOf(p, r)
          await p.evalIn(`__agent.setValue(${JSON.stringify(r)}, ${JSON.stringify(value)})`)
          traced(ctx, p, { type: 'select', selectors: target.selectors, label: target.label, value, url: p.url() })
          await settle()
          return withNotices(p, `已选择 "${value}"。\n${await changes(p)}`)
        }),
      { name: 'browser_select', description: '在下拉框 <select> 中选择选项（按 value 或显示文本）。', schema: z.object({ ref, value: z.string() }) },
    ),
    tool(
      async ({ ref: r }) =>
        onPage(ctx, async (p) => {
          const { x, y } = await center(p, r)
          await browser.hover(p, x, y)
          await settle()
          return withNotices(p, await changes(p))
        }),
      { name: 'browser_hover', description: '鼠标悬停到元素上（用于展开菜单等）。', schema: z.object({ ref }) },
    ),
    tool(
      async ({ key }) =>
        onPage(ctx, async (p) => {
          traced(ctx, p, { type: 'press', key, url: p.url() })
          await browser.pressKey(p, key)
          await settle(500)
          await p.waitForLoad(8000)
          return withNotices(p, await changes(p))
        }),
      {
        name: 'browser_press_key',
        description: '按下键盘按键，例如 Enter、Tab、Escape、ArrowDown、PageDown 或单个字符。',
        schema: z.object({ key: z.string() }),
      },
    ),
    tool(
      async ({ direction, amount }) =>
        onPage(ctx, async (p) => {
          const px = amount ?? 700
          await browser.scroll(p, 0, direction === 'up' ? -px : px)
          await settle()
          return withNotices(p, await changes(p))
        }),
      {
        name: 'browser_scroll',
        description: '滚动页面，返回新出现的内容。',
        schema: z.object({ direction: z.enum(['up', 'down']), amount: z.number().optional().describe('像素，默认 700') }),
      },
    ),
    tool(
      async ({ text, selector, timeoutMs }) =>
        onPage(ctx, async (p) => {
          const deadline = Date.now() + (timeoutMs ?? 10000)
          while (Date.now() < deadline) {
            const found = await p.evalIn<boolean>(
              selector ? `!!__agent.query([${JSON.stringify(selector)}])` : `document.body && document.body.innerText.includes(${JSON.stringify(text ?? '')})`,
            )
            if (found) return withNotices(p, `已出现。\n${await changes(p)}`)
            await settle(400)
          }
          return withNotices(p, '等待超时，目标未出现。')
        }),
      {
        name: 'browser_wait_for',
        description: '等待页面出现指定文本或 CSS 选择器。',
        schema: z.object({ text: z.string().optional(), selector: z.string().optional(), timeoutMs: z.number().optional() }),
      },
    ),
    tool(
      async ({ fullPage }) =>
        onPage(ctx, async (p) => {
          // hidden views don't paint: bring the conversation's tab to the front first
          await p.bringToFront()
          const data = await Promise.race([
            browser.screenshot(p, fullPage),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error(t('截图超时：标签页可能不可见，请先打开浏览器面板'))), 8000)),
          ])
          return [
            { type: 'text', text: withNotices(p, header(p)) },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } },
          ]
        }),
      { name: 'browser_screenshot', description: '截取当前页面截图（需要支持视觉的模型）。', schema: z.object({ fullPage: z.boolean().optional() }) },
    ),
    tool(
      async ({ selector }) =>
        onPage(ctx, async (p) => {
          const text = await p.evalIn<string>(`__agent.extract(${JSON.stringify(selector ?? null)} || undefined)`)
          return withNotices(p, `${header(p)}\n\n${text}`)
        }),
      {
        name: 'browser_extract',
        description: '提取页面（或选择器范围内）的可读文本，用于阅读文章、表格、搜索结果等。比反复快照更省。',
        schema: z.object({ selector: z.string().optional() }),
      },
    ),
    tool(
      async ({ script }) =>
        onPage(ctx, async (p) => {
          const result = await p.evalMain(script)
          return withNotices(p, JSON.stringify(result ?? null, null, 2).slice(0, 20000))
        }),
      {
        name: 'browser_eval',
        description: '在页面主环境执行 JavaScript（函数体，需 return 结果）。需要用户批准；仅在其他工具无法完成时使用，读取页面文字请用 browser_extract。',
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
            return `已新建并切换到标签页 ${id}。\n${await fullSnapshot(builtinDriver(browser.tab(id)!))}`
          }
          case 'switch': {
            if (tabId == null || !browser.tab(tabId)) return '需要有效的 tabId'
            if (ctx.threadId) sessions.assign(ctx.threadId, tabId)
            browser.activate(tabId)
            return fullSnapshot(builtinDriver(browser.tab(tabId)!))
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
        onPage(ctx, async (p) => {
          if (!(await p.history(action))) return '无法' + (action === 'back' ? '后退' : '前进')
          await settle(800)
          await p.waitForLoad()
          return withNotices(p, await fullSnapshot(p))
        }),
      { name: 'browser_history', description: '浏览器后退或前进。', schema: z.object({ action: z.enum(['back', 'forward']) }) },
    ),
    tool(
      async ({ ref: r, files }) =>
        onPage(ctx, async (p) => {
          const pending = p.chooser()
          if (pending) {
            await p.cdp('DOM.setFileInputFiles', { files, backendNodeId: pending.backendNodeId })
            p.clearChooser()
          } else {
            if (!r) return '当前没有打开的文件选择框，请提供文件输入框的 ref'
            const { x, y } = await center(p, r)
            await p.cdp('DOM.getDocument')
            const { backendNodeId } = await p.cdp<{ backendNodeId: number }>('DOM.getNodeForLocation', { x, y })
            await p.cdp('DOM.setFileInputFiles', { backendNodeId, files })
          }
          await settle()
          return withNotices(p, `已选择 ${files.length} 个文件。\n${await changes(p)}`)
        }),
      {
        name: 'browser_upload_file',
        description: '上传本地文件（绝对路径）。若页面已打开文件选择框则直接使用；否则需提供文件输入框的 ref。',
        schema: z.object({ ref: ref.optional(), files: z.array(z.string()).min(1) }),
      },
    ),
    tool(
      async ({ confirm, promptText }) =>
        onPage(ctx, async (p) => {
          await p.setDialogPolicy({ confirm, prompt: promptText ?? null })
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
