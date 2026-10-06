import type {
  Bounds,
  BrowserState,
  ChatEvent,
  ConnectorDef,
  ConnectorState,
  Decision,
  Macro,
  MacroRunResult,
  DiscoveredMcp,
  DownloadInfo,
  FileEngine,
  FileEngineStatus,
  FileRecord,
  McpServer,
  McpStatus,
  DayEntry,
  Memory,
  MemoryInput,
  MemoryLearned,
  MemoryMerge,
  ModelConfig,
  ModelInput,
  PluginInfo,
  Provider,
  ProviderInput,
  McpServerStatus,
  Settings,
  Skill,
  SkillSource,
  Task,
  TaskRun,
  Thread,
  ThreadState,
  TraceEntry,
} from './types'

/** Request/response methods: renderer -> main via ipcRenderer.invoke */
export interface Api {
  // models
  'providers.list': () => Provider[]
  'providers.save': (input: ProviderInput) => Provider
  'providers.delete': (id: string) => void
  'providers.fetchModels': (id: string) => string[]
  'models.list': () => ModelConfig[]
  'models.save': (input: ModelInput) => ModelConfig
  'models.delete': (id: string) => void
  'models.setDefault': (id: string) => void
  'models.test': (id: string) => { ok: boolean; latencyMs: number; reply?: string; error?: string }

  // chat
  'threads.list': () => Thread[]
  'threads.create': (modelId?: string | null) => Thread
  'threads.rename': (id: string, title: string) => void
  'threads.delete': (id: string) => void
  'threads.setModel': (id: string, modelId: string) => void
  'threads.state': (id: string) => ThreadState
  'chat.send': (threadId: string, text: string, images?: string[], fileIds?: string[]) => void
  /** alwaysAllow: tool names to stop asking about in this conversation */
  'chat.resume': (threadId: string, decisions: Decision[], alwaysAllow?: string[]) => void
  /** Re-run from a user message; pass text to edit it first */
  'chat.regenerate': (threadId: string, messageId: string, text?: string) => void
  'chat.stop': (threadId: string) => void

  // browser
  'browser.state': () => BrowserState
  'browser.setBounds': (bounds: Bounds | null) => void
  'browser.newTab': (url?: string) => number
  'browser.closeTab': (id: number) => void
  'browser.activate': (id: number) => void
  'browser.navigate': (url: string) => void
  'browser.back': () => void
  'browser.forward': () => void
  'browser.reload': () => void
  'browser.takeOver': () => void
  'browser.openDevTools': () => void
  /** JPEG data URL of the active tab, shown as a stand-in while the native view is hidden */
  'browser.capture': () => string | null
  /** mini window shown/hidden: frames arrive as `browser.preview` */
  'browser.setPreview': (on: boolean) => void

  // skills
  'skills.list': () => Skill[]
  'skills.read': (name: string) => string
  'skills.save': (name: string, content: string) => void
  'skills.delete': (name: string) => void
  'skills.setEnabled': (name: string, enabled: boolean) => void
  'skills.import': () => Skill[]
  'skills.reveal': (name: string) => void
  'skills.sources': () => SkillSource[]
  'skills.addSource': () => SkillSource | null
  'skills.removeSource': (id: string) => void
  /** Copies an external skill into the local library so it can be edited */
  'skills.copyToLocal': (id: string) => Skill

  // memory
  'memory.list': () => Memory[]
  /** create (no id) or edit; near-duplicates of an existing memory update it instead */
  'memory.save': (input: MemoryInput & { id?: string }) => Memory
  'memory.delete': (id: string) => void
  /** undo a delete: puts the memory back with its history */
  'memory.restore': (memory: Memory) => void
  'memory.pin': (id: string, pinned: boolean) => void
  'memory.confirm': (ids: string[]) => void
  /** reverts an automatic learning batch */
  'memory.undo': (batchId: string) => void
  'memory.clear': () => void
  /** tidy now: merge duplicates, resolve contradictions, retire outdated memories */
  'memory.consolidate': () => { changed: number; conflicts: number }
  'memory.merges': () => MemoryMerge[]
  'memory.undoMerge': (id: string) => void
  /** decide a contradiction: the memories to keep (the others are archived); all = keep both */
  'memory.resolveConflict': (id: string, keepIds: string[]) => void
  /** daily journal, newest day first */
  'memory.days': (limit?: number) => DayEntry[]
  /** development: what automatic learning would do for an exchange (nothing is stored) */
  'dev.memoryDryRun': (
    exchange: { userText: string; reply: string; actions: string[]; todayLog?: string | null },
    existing: Memory[],
  ) => { raw: string; ops: Record<string, unknown>[]; journal: string | null }
  'memory.editDay': (day: string, threadId: string, text: string) => void
  'memory.deleteDay': (day: string, threadId: string) => void
  'memory.threadEnabled': (threadId: string) => boolean
  'memory.setThreadEnabled': (threadId: string, enabled: boolean) => void

  // mcp
  'mcp.list': () => McpServer[]
  'mcp.save': (server: Omit<McpServer, 'id'> & { id?: string }) => McpServer
  'mcp.delete': (id: string) => void
  'mcp.status': () => McpStatus[]
  'mcp.reconnect': (id: string) => void
  'mcp.importJson': (json: string) => McpServer[]
  /** Scans .agents, Claude Code, Claude Desktop, Cursor, Codex and Gemini configs */
  'mcp.discover': () => DiscoveredMcp[]
  'mcp.importDiscovered': (keys: string[]) => McpServer[]

  // connectors
  'connectors.catalog': () => ConnectorDef[]
  'connectors.states': () => ConnectorState[]
  'connectors.connect': (id: string, token?: string) => ConnectorState
  'connectors.disconnect': (id: string) => void
  'connectors.setEnabled': (id: string, enabled: boolean) => void
  'connectors.addCustom': (def: Omit<ConnectorDef, 'id' | 'custom' | 'icon'>) => ConnectorDef

  // plugins
  'plugins.list': () => PluginInfo[]
  'plugins.setEnabled': (id: string, enabled: boolean) => void
  'plugins.readFile': (id: string, file: string) => string
  'plugins.writeFile': (id: string, file: string, content: string) => void
  'plugins.create': (id: string, name: string) => PluginInfo
  'plugins.delete': (id: string) => void
  'plugins.import': () => PluginInfo[]
  'plugins.reload': () => PluginInfo[]
  'plugins.runAction': (id: string, action: string, args: Record<string, unknown>) => unknown
  'plugins.activeForTab': () => string[]

  // macros
  'macros.list': () => Macro[]
  'macros.save': (macro: Macro) => Macro
  'macros.delete': (id: string) => void
  'macros.startRecording': () => void
  'macros.stopRecording': () => Macro | null
  'macros.run': (id: string, params: Record<string, string>) => MacroRunResult
  'macros.toSkill': (id: string) => string

  // tasks
  'tasks.list': () => Task[]
  'tasks.save': (task: Omit<Task, 'id' | 'createdAt'> & { id?: string }) => Task
  'tasks.delete': (id: string) => void
  'tasks.run': (id: string) => TaskRun
  'tasks.runs': (taskId?: string) => TaskRun[]
  'tasks.cancel': (runId: string) => void

  // settings / dev
  'settings.get': () => Settings
  'settings.set': (patch: Partial<Settings> & { langsmithApiKey?: string; langfuseSecretKey?: string; mineruToken?: string }) => Settings
  'files.list': () => FileRecord[]
  'files.get': (id: string) => FileRecord
  /** opens the system file picker; returns the created records */
  'files.pick': () => FileRecord[]
  /** local paths (drag & drop) */
  'files.addPaths': (paths: string[]) => FileRecord[]
  /** in-memory data (clipboard paste) */
  'files.addData': (name: string, data: Uint8Array) => FileRecord
  'files.markdown': (id: string) => string
  'files.thumbnail': (id: string) => string | null
  'files.image': (id: string) => string | null
  'files.reparse': (id: string, engine?: FileEngine) => FileRecord
  'files.delete': (id: string) => void
  'files.reveal': (id: string) => void
  'files.engines': () => FileEngineStatus[]
  'navoMcp.status': () => McpServerStatus
  /** reveal the bearer token so the user can paste it into another agent */
  'navoMcp.token': () => string
  'navoMcp.regenerateToken': () => string
  /** registers Navo in ~/.agents/mcp.json (backs up the file first) */
  'navoMcp.installAgents': () => { path: string; backup: string | null }
  'langfuse.test': () => { ok: boolean; projectId?: string; projectName?: string; error?: string }
  'dev.traces': (threadId?: string) => TraceEntry[]
  'dev.clearTraces': () => void
  'dev.tools': () => { name: string; description: string; source: string; schema: unknown }[]
  'dev.invokeTool': (name: string, args: Record<string, unknown>) => unknown
  'dev.logs': () => string[]
  'app.openExternal': (url: string) => void
  'app.showItem': (path: string) => void
  'browser.downloads': () => DownloadInfo[]
  'app.paths': () => { userData: string; skills: string; plugins: string }
}

/** Push events: main -> renderer */
export interface Events {
  'memory.changed': void
  'memory.learned': MemoryLearned
  'memory.consolidated': { changed: number; conflicts: number }
  'chat.event': ChatEvent
  'threads.changed': void
  'browser.state': BrowserState
  /** Ask the renderer to show the browser panel (agent started using it, or a link opened a tab) */
  /** open: user action → open the panel; otherwise (agent activity) a collapsed panel gets the mini window */
  'browser.reveal': { open: boolean }
  'browser.preview': { tabId: number; image: string }
  'browser.download': DownloadInfo
  'mcp.status': McpStatus[]
  'connectors.changed': void
  'macros.recording': { steps: number; last?: string }
  'tasks.changed': void
  'dev.log': string
  'navoMcp.status': McpServerStatus
  /** settings changed from anywhere (UI, onboarding, MCP) */
  'settings.changed': Settings
  'files.changed': FileRecord
}

export type ApiMethod = keyof Api
export type ApiArgs<M extends ApiMethod> = Parameters<Api[M]>
export type ApiResult<M extends ApiMethod> = ReturnType<Api[M]>
export type EventName = keyof Events

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }
