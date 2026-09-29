import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { dialog, type WebContents } from 'electron'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { PluginInfo } from '@shared/types'
import { db } from '../core/db'
import { log } from '../core/logger'
import { paths } from '../core/paths'
import { browser } from '../browser/browser-service'
import { EXAMPLE_PLUGINS } from './examples'
import { matchPattern, validateManifest } from './manifest'

function wrap(p: PluginInfo, source: string): string {
  return `(() => {
    const root = (window.__agentPlugins = window.__agentPlugins || {});
    const agentPlugin = {
      id: ${JSON.stringify(p.id)},
      actions: {},
      register(name, fn) { this.actions[name] = fn; },
      log(...args) { try { console.debug('__navo_plugin__' + JSON.stringify({ id: ${JSON.stringify(p.id)}, args: args.map(String) })); } catch {} },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      async waitFor(selector, timeout = 10000) {
        const end = Date.now() + timeout;
        while (Date.now() < end) { const el = document.querySelector(selector); if (el) return el; await new Promise((r) => setTimeout(r, 200)); }
        throw new Error('等待元素超时: ' + selector);
      },
    };
    root[${JSON.stringify(p.id)}] = agentPlugin;
    const __agentPlugin = agentPlugin;
    try {
      ${source}
    } catch (e) { agentPlugin.log('init error', e && e.message); }
  })();`
}

/**
 * Every plugin gets its own isolated world so it can't tamper with the agent runtime (world 999)
 * or with other plugins. Chromium world ids just need to be stable integers.
 */
const FIRST_PLUGIN_WORLD = 1001

class PluginService {
  private cache: PluginInfo[] | null = null
  private worlds = new Map<string, number>()
  private logging = new WeakSet<WebContents>()

  private world(id: string): number {
    let w = this.worlds.get(id)
    if (w == null) {
      w = FIRST_PLUGIN_WORLD + this.worlds.size
      this.worlds.set(id, w)
    }
    return w
  }

  init(): void {
    this.seedExamples()
    browser.onDomReady((wc) => this.inject(wc))
  }

  private seedExamples(): void {
    if (db().prepare("SELECT 1 FROM kv WHERE key = 'plugins.seeded'").get()) return
    for (const ex of EXAMPLE_PLUGINS) {
      const dir = join(paths.plugins, ex.manifest.id)
      if (existsSync(dir)) continue
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(ex.manifest, null, 2))
      writeFileSync(join(dir, ex.manifest.contentScript), ex.content)
    }
    db().prepare("INSERT INTO kv(key, value) VALUES('plugins.seeded', 'true')").run()
  }

  private enabledMap(): Map<string, boolean> {
    const rows = db().prepare('SELECT id, enabled FROM plugin_state').all() as { id: string; enabled: number }[]
    return new Map(rows.map((r) => [r.id, !!r.enabled]))
  }

  list(): PluginInfo[] {
    if (this.cache) return this.cache
    const enabled = this.enabledMap()
    const out: PluginInfo[] = []
    for (const d of readdirSync(paths.plugins, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const dir = join(paths.plugins, d.name)
      const mf = join(dir, 'manifest.json')
      if (!existsSync(mf)) continue
      try {
        const m = validateManifest(JSON.parse(readFileSync(mf, 'utf8')))
        out.push({ ...m, dir, enabled: enabled.get(m.id) ?? true })
      } catch (err) {
        out.push({
          id: d.name,
          name: d.name,
          matches: [],
          contentScript: 'content.js',
          actions: [],
          dir,
          enabled: false,
          error: err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : String(err),
        })
      }
    }
    this.cache = out.sort((a, b) => a.name.localeCompare(b.name))
    return this.cache
  }

  reload(): PluginInfo[] {
    this.cache = null
    const list = this.list()
    for (const wc of browser.allTabs()) void this.inject(wc)
    return list
  }

  get(id: string): PluginInfo {
    const p = this.list().find((x) => x.id === id)
    if (!p) throw new Error(`插件不存在: ${id}`)
    return p
  }

  setEnabled(id: string, enabled: boolean): void {
    db()
      .prepare('INSERT INTO plugin_state(id, enabled) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled')
      .run(id, enabled ? 1 : 0)
    this.reload()
  }

  private file(id: string, file: string): string {
    const dir = join(paths.plugins, id)
    const full = resolve(dir, file)
    if (!full.startsWith(dir + sep)) throw new Error('非法路径')
    return full
  }

  readFile(id: string, file: string): string {
    return readFileSync(this.file(id, file), 'utf8')
  }

  writeFile(id: string, file: string, content: string): void {
    if (file === 'manifest.json') validateManifest(JSON.parse(content))
    writeFileSync(this.file(id, file), content)
    this.reload()
  }

  create(id: string, name: string): PluginInfo {
    const manifest = validateManifest({
      id,
      name,
      description: '',
      matches: ['https://example.com/*'],
      contentScript: 'content.js',
      actions: [
        {
          name: 'get_title',
          description: '返回页面主标题',
          parameters: { type: 'object', properties: {} },
        },
      ],
    })
    const dir = join(paths.plugins, id)
    if (existsSync(dir)) throw new Error('插件 id 已存在')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
    writeFileSync(
      join(dir, 'content.js'),
      `// 在隔离环境中运行，可直接操作 DOM。用 agentPlugin.register 注册动作，返回值会交给 Agent。\nagentPlugin.register('get_title', async () => {\n  return document.querySelector('h1')?.textContent?.trim() ?? document.title\n})\n`,
    )
    this.reload()
    return this.get(id)
  }

  delete(id: string): void {
    rmSync(join(paths.plugins, id), { recursive: true, force: true })
    db().prepare('DELETE FROM plugin_state WHERE id = ?').run(id)
    this.reload()
  }

  async import(): Promise<PluginInfo[]> {
    const res = await dialog.showOpenDialog({ title: '选择插件文件夹（包含 manifest.json）', properties: ['openDirectory', 'multiSelections'] })
    for (const src of res.filePaths) {
      const m = validateManifest(JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8')))
      cpSync(src, join(paths.plugins, m.id || basename(src)), { recursive: true })
    }
    return this.reload()
  }

  matching(url: string): PluginInfo[] {
    return this.list().filter((p) => p.enabled && !p.error && p.matches.some((m) => matchPattern(m, url)))
  }

  private watchLogs(wc: WebContents): void {
    if (this.logging.has(wc)) return
    this.logging.add(wc)
    wc.on('console-message', ((...args: unknown[]) => {
      const first = args[0] as { message?: string }
      const message = typeof first?.message === 'string' ? first.message : (args[2] as string)
      if (typeof message !== 'string' || !message.startsWith('__navo_plugin__')) return
      try {
        const { id, args: a } = JSON.parse(message.slice('__navo_plugin__'.length)) as { id: string; args: string[] }
        log.info(`[plugin:${id}]`, ...a)
      } catch {
        /* ignore */
      }
    }) as never)
  }

  async inject(wc: WebContents): Promise<void> {
    const matching = this.matching(wc.getURL())
    if (matching.length) this.watchLogs(wc)
    for (const p of matching) {
      try {
        const src = readFileSync(join(p.dir, p.contentScript), 'utf8')
        await wc.executeJavaScriptInIsolatedWorld(this.world(p.id), [{ code: wrap(p, src) }])
      } catch (err) {
        log.warn(`[plugin:${p.id}] inject failed: ${(err as Error).message}`)
      }
    }
  }

  async runAction(id: string, action: string, args: Record<string, unknown>, wc = browser.active()): Promise<unknown> {
    const p = this.get(id)
    if (!p.matches.some((m) => matchPattern(m, wc.getURL()))) throw new Error(`当前页面不匹配插件 ${p.name}`)
    const world = this.world(id)
    const inWorld = (code: string) => wc.executeJavaScriptInIsolatedWorld(world, [{ code }], true)
    const ready = await inWorld(`!!(window.__agentPlugins && window.__agentPlugins[${JSON.stringify(id)}])`)
    if (!ready) await this.inject(wc)
    return inWorld(
      `(async () => {
        const p = window.__agentPlugins && window.__agentPlugins[${JSON.stringify(id)}];
        if (!p) throw new Error('插件未加载');
        const fn = p.actions[${JSON.stringify(action)}];
        if (!fn) throw new Error('动作未注册: ${action}');
        return await fn(${JSON.stringify(args)});
      })()`,
    )
  }

  activeForTab(): string[] {
    return this.matching(browser.active().getURL()).map((p) => p.id)
  }

  /** Tools for plugins that match the given tab, rebuilt every agent run. */
  tools(getTab: () => WebContents = () => browser.active()): StructuredToolInterface[] {
    const url = getTab().getURL()
    return this.matching(url).flatMap((p) =>
      p.actions.map((a) =>
        tool(
          async (args: Record<string, unknown>) => {
            const wc = getTab()
            await browser.setControlled(wc, true)
            const res = await this.runAction(p.id, a.name, args ?? {}, wc)
            return typeof res === 'string' ? res : JSON.stringify(res ?? null, null, 2)
          },
          {
            name: `plugin_${p.id.replace(/-/g, '_')}_${a.name}`.slice(0, 64),
            description: `[站点插件 ${p.name}] ${a.description}`,
            schema: a.parameters as Record<string, unknown>,
          },
        ),
      ),
    ) as StructuredToolInterface[]
  }

  /** Short description for the system prompt so the model knows plugins exist for other sites too. */
  describe(): string {
    const list = this.list().filter((p) => p.enabled && !p.error)
    if (!list.length) return ''
    return list.map((p) => `- ${p.name}（${p.matches.join(', ')}）: ${p.actions.map((a) => a.name).join(', ')}`).join('\n')
  }
}

export const plugins = new PluginService()
