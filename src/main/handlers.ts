import { shell } from 'electron'
import { handleAll } from './core/ipc'
import { log } from './core/logger'
import { paths } from './core/paths'
import { getSettings, setSettings, testLangfuse } from './core/settings'
import { models, providers, testModel } from './models/registry'
import { agent } from './agent/agent-service'
import { collectTools, describeTools } from './agent/tool-registry'
import { activeTabCtx } from './browser/tools'
import { sessions } from './browser/agent-session'
import { browser } from './browser/browser-service'
import { skills } from './skills/skill-service'
import { memory } from './memory/memory-service'
import { mcp } from './mcp/mcp-service'
import { connectors } from './connectors/connector-service'
import { plugins } from './plugins/plugin-service'
import { recorder } from './recorder/recorder-service'
import { tasks } from './tasks/task-service'
import { traces } from './dev/traces-store'
import { files } from './files/file-service'
import { navoMcpServer } from './mcp-server/navo-mcp-server'

let sandboxRelease: NodeJS.Timeout | undefined

function background(p: Promise<unknown>): void {
  p.catch((err) => log.error(err))
}

export function registerHandlers(): void {
  handleAll({
    'providers.list': () => providers.list(),
    'providers.save': (input) => providers.save(input),
    'providers.delete': (id) => providers.delete(id),
    'providers.fetchModels': (id) => providers.fetchModels(id),
    'models.list': () => models.list(),
    'models.save': (input) => models.save(input),
    'models.delete': (id) => models.delete(id),
    'models.setDefault': (id) => models.setDefault(id),
    'models.test': (id) => testModel(id),

    'threads.list': () => agent.listThreads(),
    'threads.create': (modelId) => agent.createThread(modelId),
    'threads.rename': (id, title) => agent.renameThread(id, title),
    'threads.delete': (id) => agent.deleteThread(id),
    'threads.setModel': (id, modelId) => agent.setThreadModel(id, modelId),
    'threads.state': (id) => agent.threadState(id),
    // runs stream via events; the invoke returns immediately
    'chat.send': (threadId, text, images, fileIds) => {
      if (agent.isRunning(threadId)) throw new Error('该会话正在运行中')
      background(agent.send_(threadId, text, images, {}, fileIds ?? []))
    },
    'chat.resume': (threadId, decisions, alwaysAllow) => {
      background(agent.resume(threadId, decisions, alwaysAllow))
    },
    'chat.regenerate': async (threadId, messageId, text) => {
      if (agent.isRunning(threadId)) throw new Error('该会话正在运行中')
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

    'memory.list': () => memory.list(),
    'memory.save': (input) => memory.save(input).memory,
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
    'connectors.connect': (id, token) => connectors.connect(id, token),
    'connectors.disconnect': (id) => connectors.disconnect(id),
    'connectors.setEnabled': (id, enabled) => connectors.setEnabled(id, enabled),
    'connectors.addCustom': (def) => connectors.addCustom(def),

    'plugins.list': () => plugins.list(),
    'plugins.setEnabled': (id, enabled) => plugins.setEnabled(id, enabled),
    'plugins.readFile': (id, file) => plugins.readFile(id, file),
    'plugins.writeFile': (id, file, content) => plugins.writeFile(id, file, content),
    'plugins.create': (id, name) => plugins.create(id, name),
    'plugins.delete': (id) => plugins.delete(id),
    'plugins.import': () => plugins.import(),
    'plugins.reload': () => plugins.reload(),
    'plugins.runAction': (id, action, args) => plugins.runAction(id, action, args),
    'plugins.activeForTab': () => plugins.activeForTab(),

    'macros.list': () => recorder.list(),
    'macros.save': (m) => recorder.save(m),
    'macros.delete': (id) => recorder.delete(id),
    'macros.startRecording': () => recorder.start(),
    'macros.stopRecording': () => recorder.stop(),
    'macros.run': (id, params) => recorder.run(id, params),
    'macros.toSkill': (id) => recorder.toSkill(id),

    'tasks.list': () => tasks.list(),
    'tasks.save': (t) => tasks.save(t),
    'tasks.delete': (id) => tasks.delete(id),
    'tasks.run': (id) => tasks.run(id),
    'tasks.runs': (taskId) => tasks.runs(taskId),
    'tasks.cancel': (runId) => tasks.cancel(runId),

    'settings.get': () => getSettings(),
    'settings.set': (patch) => {
      const s = setSettings(patch)
      agent.refreshHost()
      if (patch.mcpServer) void navoMcpServer.apply()
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
    'dev.tools': () => describeTools(collectTools(activeTabCtx)),
    'dev.invokeTool': async (name, args) => {
      const entry = collectTools(activeTabCtx).find((e) => e.tool.name === name)
      if (!entry) throw new Error(`工具不存在: ${name}`)
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
    'app.openExternal': (url) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    },
    'app.paths': () => ({ userData: paths.userData, skills: paths.skills, plugins: paths.plugins }),
  })
}
