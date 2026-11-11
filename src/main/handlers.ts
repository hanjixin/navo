import { shell, dialog, BrowserWindow } from 'electron'
import { emit, handleAll } from './core/ipc'
import { log } from './core/logger'
import { paths } from './core/paths'
import { getSettings, setSettings, testLangfuse, getIntegrationStatus } from './core/settings'
import { models, providers, testModel } from './models/registry'
import { agent } from './agent/agent-service'
import { runtimeRegistry } from './agent-runtime/registry'
import { drafts } from './chat/drafts'
import { collectTools, describeTools } from './agent/tool-registry'
import { activeTabCtx } from './browser/tools'
import { sessions } from './browser/agent-session'
import { browser } from './browser/browser-service'
import { skills } from './skills/skill-service'
import { memory } from './memory/memory-service'
import { flows } from './flows/flows'
import { quick } from './quick/quick-service'
import { computerUse } from './computer-use'
import { desktopConsent } from './desktop/desktop-service'
import { skillEvolution } from './skills/evolution'
import { skillVersions } from './skills/versions'
import { skillDiscovery } from './skills/discovery'
import { mcp } from './mcp/mcp-service'
import { connectors } from './connectors/connector-service'
import { plugins } from './plugins/plugin-service'
import { recorder } from './recorder/recorder-service'
import { tasks } from './tasks/task-service'
import { monitor } from './monitor/monitor-service'
import { usage } from './usage/usage-service'
import { voice } from './voice/voice-service'
import { resolveLanguage } from './core/language'
import { outputs } from './outputs/outputs-service'
import { projects } from './projects/project-service'
import { projectFiles } from './projects/project-files'
import { traces } from './dev/traces-store'
import { files } from './files/file-service'
import { navoMcpServer } from './mcp-server/navo-mcp-server'
import { t } from '@shared/i18n'
import { isAbsolute } from 'node:path'

let sandboxRelease: NodeJS.Timeout | undefined

function textArg(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1_000_000 || value.includes('\0')) throw new Error(`非法参数: ${name}`)
  return value
}

function absolutePath(value: unknown, name: string): string {
  const p = textArg(value, name)
  if (!isAbsolute(p)) throw new Error(`必须是绝对路径: ${name}`)
  return p
}

function background(p: Promise<unknown>): void {
  p.catch((err) => log.error(err))
}

export function registerHandlers(): void {
  handleAll({
    'runtimes.list': () => runtimeRegistry.list(),
    'runtimes.save': (profile) => runtimeRegistry.save(profile),
    'runtimes.probe': (id) => runtimeRegistry.probe(id),
    'settings.integrationStatus': () => getIntegrationStatus(),
    'drafts.get': (scope) => drafts.get(scope),
    'drafts.save': (input) => drafts.save(input),
    'drafts.clear': (scope, version) => drafts.clear(scope, version),
    'drafts.move': (source, target, version) => drafts.move(source, target, version),
    'chat.submit': (input) => agent.submit(input),
    'approvals.list': async () => [
      ...(await agent.approvalSummaries()).map((item) => ({ ...item, kind: 'tool' as const })),
      ...desktopConsent.pending().map((request) => ({
        kind: 'desktop' as const,
        id: request.id,
        threadId: request.threadId,
        threadTitle: agent.getThread(request.threadId)?.title ?? t('新对话'),
        executionId: request.executionId,
        createdAt: request.createdAt,
        request,
      })),
    ],
    'providers.list': () => providers.list(),
    'providers.save': (input) => providers.save(input),
    'providers.delete': (id) => providers.delete(id),
    'providers.fetchModels': (id) => providers.fetchModels(id),
    'providers.importModels': (id) => providers.importModels(id),
    'models.list': () => models.list(),
    'models.save': (input) => models.save(input),
    'models.delete': (id) => models.delete(id),
    'models.setDefault': (id) => models.setDefault(id),
    'models.setEnabled': (id, enabled) => models.setEnabled(id, enabled),
    'models.setEnabledMany': (ids, enabled) => models.setEnabledMany(ids, enabled),
    'models.affectedTasks': (ids) => models.affectedTasks(ids),
    'models.test': (id) => testModel(id),

    'threads.list': () => agent.listThreads(),
    'threads.create': (modelId, projectId, runtimeId) => agent.createThread(modelId, { projectId, runtimeId }),
    'threads.setProject': (id, projectId) => agent.setThreadProject(id, projectId),
    'projectFiles.list': (id, path, showHidden) => projectFiles.list(id, path, showHidden),
    'projectFiles.listPage': (id, path, showHidden, cursor, limit) => projectFiles.listPage(id, path, showHidden, cursor, limit),
    'projectFiles.search': (id, query, requestId, showHidden) => projectFiles.search(id, query, requestId, showHidden),
    'projectFiles.cancelSearch': (requestId) => projectFiles.cancelSearch(requestId),
    'projectFiles.preview': (id, path) => projectFiles.preview(id, path),
    'projectFiles.reveal': (id, path) => projectFiles.reveal(id, path),
    'projectFiles.openDirectory': (id) => projectFiles.openDirectory(id),
    'projects.pickDirectory': async () => {
      const win = BrowserWindow.getFocusedWindow()
      const opts = { properties: ['openDirectory'] as 'openDirectory'[] }
      const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    'projects.list': () => projects.list(),
    'projects.get': (id) => projects.get(id),
    'projects.save': (input) => projects.save(input),
    'projects.delete': (id) => projects.delete(id),
    'threads.rename': (id, title) => agent.renameThread(id, title),
    'threads.delete': (id) => agent.deleteThread(id),
    'threads.setModel': (id, modelId) => agent.setThreadModel(id, modelId),
    'threads.state': (id) => agent.threadState(id),
    // runs stream via events; the invoke returns immediately
    'chat.send': async (threadId, text, images, fileIds) => {
      await agent.submit({ requestId: crypto.randomUUID(), threadId, text, images, fileIds })
    },
    'chat.resume': async (threadId, decisions, alwaysAllow, interruptId) => {
      await agent.assertPendingApproval(threadId, interruptId)
      background(agent.resume(threadId, decisions, alwaysAllow, interruptId))
    },
    'chat.retrySubmission': async (threadId, messageId) => {
      await agent.assertRetryableSubmission(threadId, messageId)
      background(agent.retrySubmission(threadId, messageId))
    },
    'chat.regenerate': async (threadId, messageId, text) => {
      if (agent.isRunning(threadId)) throw new Error(t('该会话正在运行中'))
      background(agent.regenerate(threadId, messageId, text))
    },
    'chat.stop': (threadId) => agent.stop(threadId),

    'browser.state': () => browser.state(),
    'browser.setBounds': (b) => browser.setBounds(b),
    'browser.newTab': (url) => browser.newTab(url),
    'browser.closeTab': (id) => browser.closeTab(id),
    'browser.activate': (id) => browser.activate(id),
    'browser.navigate': (url) => browser.navigate(url),
    'browser.back': () => browser.back(),
    'browser.forward': () => browser.forward(),
    'browser.reload': () => browser.reload(),
    'browser.takeOver': () => {
      agent.stopAll()
      return browser.releaseAll()
    },
    'browser.downloads': () => browser.downloads,
    'app.showItem': (p) => shell.showItemInFolder(p),
    'browser.openDevTools': () => browser.openDevTools(),
    'browser.capture': () => browser.captureActive(),
    'browser.setPreview': (on) => browser.setPreview(on),

    'skills.list': () => skills.list(),
    'skills.read': (name) => skills.read(name),
    'skills.save': (name, content) => skills.save(name, content),
    'skills.delete': (name) => skills.delete(name),
    'skills.setEnabled': (name, enabled) => skills.setEnabled(name, enabled),
    'skills.import': () => skills.import(),
    'skills.reveal': (name) => skills.reveal(name),
    'skills.sources': () => skills.sources(),
    'skills.addSource': () => skills.addSource(),
    'skills.removeSource': (id) => skills.removeSource(id),
    'skills.copyToLocal': (id) => skills.copyToLocal(id),
    'skills.find': (query) => skillDiscovery.search(query),
    'skills.findDetails': (id) => {
      const split = String(id).split('/')
      const skillId = split.pop() ?? ''
      return skillDiscovery.details(split.join('/'), skillId)
    },
    'skills.install': async (source, skillId) => {
      const installed = await skillDiscovery.install(source, skillId)
      emit('skills.changed')
      return installed
    },
    'quick.status': () => quick.getStatus(),
    'quick.show': () => void quick.show(),
    'quick.hide': () => quick.hide(),
    'quick.screenshot': () => void quick.screenshotAsk(),
    'quick.openInMain': (threadId, source) => quick.openInMain(threadId, source),
    'skills.versions': (name) => skillVersions.history(name),
    'skills.rollback': (name, version) => skills.rollback(name, version),
    'skills.proposals': () => skillEvolution.proposals(),
    'skills.resolveProposal': (id, approve, content) => skillEvolution.resolveProposal(id, approve, content),
    'skills.stats': () => skillEvolution.stats(),

    'memory.list': () => memory.list(),
    'memory.save': (input) => {
      const m = memory.save(input).memory
      // enough tips for one site become a skill
      if (m.kind === 'site') skillEvolution.syncSiteSkills(memory.list())
      return m
    },
    'memory.delete': (id) => memory.delete(id),
    'memory.restore': (m) => memory.undelete(m),
    'memory.pin': (id, pinned) => memory.pin(id, pinned),
    'memory.confirm': (ids) => memory.confirm(ids),
    'memory.undo': (batchId) => memory.undo(batchId),
    'memory.clear': () => memory.clear(),
    'memory.consolidate': () => memory.consolidate(),
    'memory.merges': () => memory.merges(),
    'memory.undoMerge': (id) => memory.undoMerge(id),
    'memory.resolveConflict': (id, keepIds) => memory.resolveConflict(id, keepIds),
    'memory.days': (limit) => memory.days({ limit }),
    'dev.memoryDryRun': (ex, existing) => memory.dryRun(ex, existing),
    'memory.editDay': (day, threadId, text) => memory.editDay(day, threadId, text),
    'memory.deleteDay': (day, threadId) => memory.deleteDay(day, threadId),
    'memory.threadEnabled': (threadId) => memory.threadEnabled(threadId),
    'memory.setThreadEnabled': (threadId, enabled) => memory.setThreadEnabled(threadId, enabled),

    'mcp.list': () => mcp.list(),
    'mcp.save': (s) => mcp.save(s),
    'mcp.delete': (id) => mcp.delete(id),
    'mcp.status': () => mcp.status(),
    'mcp.reconnect': (id) => mcp.reconnect(id),
    'mcp.importJson': (json) => mcp.importJson(json),
    'mcp.discover': () => mcp.discover(),
    'mcp.importDiscovered': (keys) => mcp.importDiscovered(keys),

    'connectors.catalog': () => connectors.catalog(),
    'connectors.states': () => connectors.states(),
    'connectors.connect': (id, credentials) => connectors.connect(id, credentials),
    'connectors.testNotify': (id) => connectors.testNotify(id),
    'connectors.disconnect': (id) => connectors.disconnect(id),
    'connectors.setEnabled': (id, enabled) => connectors.setEnabled(id, enabled),
    'connectors.addCustom': (def) => connectors.addCustom(def),

    'plugins.list': () => plugins.list(),
    'plugins.setEnabled': (id, enabled) => plugins.setEnabled(id, enabled),
    'plugins.readFile': (id, file) => plugins.readFile(textArg(id, 'id'), textArg(file, 'file')),
    'plugins.writeFile': (id, file, content) => plugins.writeFile(textArg(id, 'id'), textArg(file, 'file'), textArg(content, 'content')),
    'plugins.create': (id, name) => plugins.create(id, name),
    'plugins.delete': (id) => plugins.delete(id),
    'plugins.import': () => plugins.import(),
    'plugins.reload': () => plugins.reload(),
    'plugins.runAction': (id, action, args) => plugins.runAction(id, action, args),
    'plugins.activeForTab': () => plugins.activeForTab(),

    'macros.list': () => recorder.list(),
    'macros.save': (m) => {
      const saved = recorder.save(m)
      flows.recordVersion(saved, 'user', t('手动编辑'))
      return saved
    },
    'macros.delete': (id) => recorder.delete(id),
    'macros.startRecording': () => recorder.start(),
    'macros.stopRecording': async () => {
      const m = await recorder.stop()
      if (m) flows.recordVersion(m, 'recorded', t('录制'))
      return m
    },
    'flows.traceInfo': (threadId) => flows.traceInfo(threadId),
    'flows.draft': (threadId) => flows.draft(threadId),
    'flows.save': (draft) => flows.save(draft),
    'flows.run': (macroId, params, repair) => flows.run(macroId, params, repair),
    'flows.stats': () => flows.stats(),
    'flows.versions': (macroId) => flows.versions(macroId),
    'flows.rollback': (macroId, version) => flows.rollback(macroId, version),
    'macros.run': (id, params) => recorder.run(id, params),
    'macros.toSkill': (id) => recorder.toSkill(id),

    'tasks.list': () => tasks.list(),
    'tasks.save': (t) => tasks.save(t),
    'tasks.delete': (id) => tasks.delete(id),
    'tasks.run': (id) => tasks.run(id),
    'tasks.runs': (taskId) => tasks.runs(taskId),
    'tasks.cancel': (runId) => tasks.cancel(runId),
    'outputs.list': (threadId) => outputs.list(threadId),
    'outputs.counts': () => outputs.counts(),
    'outputs.preview': (id) => outputs.preview(id),
    'outputs.export': (id, format, dest) => outputs.export(id, format, dest),
    'outputs.saveAs': (id) => outputs.saveAs(id),
    'outputs.reveal': (id) => outputs.reveal(id),
    'outputs.open': (id) => outputs.open(id),
    'artifacts.get': (id) => outputs.artifact(id),
    'artifacts.list': (projectId) => outputs.artifacts(projectId),
    'artifacts.query': (query) => outputs.query(query),
    'artifacts.preview': (id) => outputs.preview(id),
    'artifacts.export': (id, format, dest) => outputs.export(id, format, dest),
    'artifacts.saveAs': (id) => outputs.saveAs(id),
    'artifacts.reveal': (id) => outputs.reveal(id),
    'artifacts.open': (id) => outputs.open(id),
    'computerUse.status': () => computerUse.status(),
    'computerUse.viewState': () => computerUse.viewState(),
    'computerUse.retryView': () => computerUse.retryView(),
    'computerUse.focusView': () => computerUse.focusView(),
    'computerUse.refreshDesktop': () => computerUse.refreshDesktop(),
    'computerUse.openPermission': (kind) => computerUse.openPermission(kind),
    'computerUse.restart': () => computerUse.restart(),
    'computerUse.consent': (id, decision) => computerUse.consent(id, decision),
    'computerUse.pendingConsent': () => computerUse.pendingConsent(),
    'computerUse.consents': () => desktopConsent.pending(),
    'computerUse.grants': () => computerUse.grants(),
    'computerUse.revokeGrant': (id) => computerUse.revokeGrant(id),
    'computerUse.stop': () => computerUse.stop(),
    'computerUse.confirmPairing': (approve) => computerUse.confirmPairing(approve),
    'computerUse.installExtension': () => ({ dir: computerUse.ensureExtension().dir }),
    'computerUse.openExtensionsPage': (b) => computerUse.openExtensionsPage(b),
    'computerUse.exportExtension': () => computerUse.exportExtension(),
    'computerUse.watch': (on) => computerUse.watch(on),
    'voice.status': () => voice.status(),
    'voice.prepare': () => voice.prepare(),
    'voice.transcribe': (wav) => voice.transcribe(wav),
    'usage.report': (days) => usage.report(days),
    'models.setPricing': (id, pricing) => models.setPricing(id, pricing),
    'monitor.check': (taskId) => tasks.check(tasks.get(taskId)),
    'monitor.checks': (taskId, limit) => monitor.checks(taskId, limit),
    'monitor.summary': () =>
      monitor.summaries(
        tasks
          .list()
          .filter((t) => t.kind === 'monitor')
          .map((t) => t.id),
      ),
    'monitor.preview': (url, selector) => monitor.read(url, selector),

    'settings.get': () => getSettings(),
    'settings.set': (patch) => {
      const s = setSettings(patch)
      agent.refreshHost()
      if (patch.mcpServer) void navoMcpServer.apply()
      if (patch.quick) quick.apply()
      if (patch.computerUse) void computerUse.apply()
      return s
    },
    'langfuse.test': () => testLangfuse(),
    'files.list': () => files.list(),
    'files.get': (id) => files.get(id),
    'files.pick': () => files.pick(),
    'files.addPaths': (ps) => files.addPaths(ps),
    'files.addData': (name, data) => files.addData(name, data),
    'files.markdown': (id) => files.markdown(id),
    'files.thumbnail': (id) => files.thumbnail(id),
    'files.image': (id) => files.image(id),
    'files.reparse': (id, engine) => files.reparse(id, engine),
    'files.delete': (id) => files.delete(id),
    'files.reveal': (id) => files.reveal(id),
    'files.engines': () => files.engines(),
    'navoMcp.status': () => navoMcpServer.status(),
    'navoMcp.token': () => navoMcpServer.token(),
    'navoMcp.regenerateToken': () => navoMcpServer.regenerateToken(),
    'navoMcp.installAgents': () => navoMcpServer.installAgents(),
    'dev.traces': (threadId) => traces.list(threadId),
    'dev.clearTraces': () => traces.clear(),
    'dev.tools': () => describeTools(collectTools(activeTabCtx, true)),
    'dev.invokeTool': async (name, args) => {
      const entry = collectTools(activeTabCtx, true).find((e) => e.tool.name === name)
      if (!entry) throw new Error(t('工具不存在: {{v0}}', { v0: name }))
      clearTimeout(sandboxRelease)
      try {
        const out = await entry.tool.invoke(args)
        return typeof out === 'string' ? out : JSON.parse(JSON.stringify(out))
      } finally {
        // hand the tab back to the user shortly after the last sandbox call (keeps dialog policy etc.
        // across a sequence of manual calls, like within a real run)
        const wc = activeTabCtx.tab()
        sandboxRelease = setTimeout(() => {
          if (wc.isDestroyed()) return
          void sessions.release(wc).then(() => browser.setControlled(wc, false))
        }, 5000)
      }
    },
    'dev.logs': () => log.lines(),
    'app.showItemInFolder': (path) => shell.showItemInFolder(absolutePath(path, 'path')),
    'app.language': () => resolveLanguage(),
    'app.openExternal': (url) => {
      const value = textArg(url, 'url')
      if (/^https?:\/\//i.test(value)) void shell.openExternal(value)
    },
    'app.paths': () => ({ userData: paths.userData, skills: paths.skills, plugins: paths.plugins }),
  })
}
