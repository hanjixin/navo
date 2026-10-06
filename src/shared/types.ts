export type ProviderType = 'anthropic' | 'openai' | 'openai-responses' | 'openai-compatible'

export interface Provider {
  id: string
  type: ProviderType
  name: string
  baseURL?: string | null
  headers?: Record<string, string> | null
  hasKey: boolean
  createdAt: number
}

export interface ProviderInput {
  id?: string
  type: ProviderType
  name: string
  baseURL?: string | null
  headers?: Record<string, string> | null
  /** undefined = keep existing key, '' = clear */
  apiKey?: string
}

export interface ModelConfig {
  id: string
  providerId: string
  model: string
  displayName: string
  contextWindow?: number | null
  supportsTools: boolean
  supportsVision: boolean
  temperature?: number | null
  maxTokens?: number | null
  reasoningEffort?: 'low' | 'medium' | 'high' | null
  isDefault: boolean
}

export type ModelInput = Omit<ModelConfig, 'id' | 'isDefault'> & { id?: string; isDefault?: boolean }

export interface Thread {
  id: string
  title: string
  modelId: string | null
  createdAt: number
  updatedAt: number
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

export interface UIMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  images?: string[]
  toolCalls?: ToolCall[]
  toolCallId?: string
  toolName?: string
  status?: 'success' | 'error'
  /** subagent namespace, empty for main agent */
  ns?: string
  /** Model reasoning / thinking text (Anthropic thinking, OpenAI reasoning summaries, DeepSeek) */
  reasoning?: string
  /** files attached to a user message */
  attachments?: MessageAttachment[]
  /** memories the reply to this user message could draw on */
  memories?: MemoryRef[]
}

export interface Todo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface ActionRequest {
  name: string
  args: Record<string, unknown>
  description?: string
}

export interface PendingInterrupt {
  id: string
  actionRequests: ActionRequest[]
  allowedDecisions: ('approve' | 'edit' | 'reject')[][]
}

export type Decision =
  { type: 'approve' } | { type: 'reject'; message?: string } | { type: 'edit'; editedAction: { name: string; args: Record<string, unknown> } }

export type ChatEvent =
  | { type: 'run_start'; threadId: string; runId: string }
  | { type: 'token'; threadId: string; messageId: string; text: string; ns?: string; reasoning?: boolean }
  | { type: 'message'; threadId: string; message: UIMessage }
  | { type: 'todos'; threadId: string; todos: Todo[] }
  | { type: 'interrupt'; threadId: string; interrupt: PendingInterrupt }
  | { type: 'error'; threadId: string; error: string }
  | { type: 'run_end'; threadId: string; runId: string; aborted?: boolean; traceUrl?: string }

export interface ThreadState {
  messages: UIMessage[]
  todos: Todo[]
  interrupt: PendingInterrupt | null
  running: boolean
}

// ---------- Browser ----------
export interface BrowserTab {
  id: number
  url: string
  title: string
  favicon?: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  active: boolean
  /** Conversation using this tab */
  agent?: { threadId: string; title: string; running: boolean }
}

export interface DownloadInfo {
  id: string
  tabId: number | null
  filename: string
  path: string
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  received: number
  total: number
}

export interface BrowserState {
  tabs: BrowserTab[]
  agentControlled: boolean
  recording: boolean
}

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

// ---------- Skills ----------
export interface Skill {
  /** Stable key: the name for local skills, `ext:<mountId>/<dir>` for skills from external sources */
  id: string
  name: string
  description: string
  enabled: boolean
  path: string
  /** 'local' or the external mount id */
  source: string
  sourceLabel: string
  readOnly: boolean
  /** Where an external skill was installed from (e.g. a GitHub repo from .skill-lock.json) */
  origin?: string
  /** A local skill with the same name overrides this one */
  shadowed?: boolean
}

export interface SkillSource {
  id: string
  label: string
  path: string
  builtin: boolean
  exists: boolean
  skillCount: number
}

export interface DiscoveredMcp {
  /** `<sourceId>:<name>` */
  key: string
  name: string
  sourceId: string
  sourceLabel: string
  sourcePath: string
  transport: McpTransport
  command?: string | null
  args?: string[] | null
  env?: Record<string, string> | null
  url?: string | null
  headers?: Record<string, string> | null
  /** Built-in connector with the same remote host */
  connectorId?: string
  imported: boolean
}

// ---------- Memory ----------
// ---------- Memory ----------

/** profile: who the user is · preference: how they want things done · knowledge: projects, people, context · site: how-tos for one website */
export type MemoryKind = 'profile' | 'preference' | 'knowledge' | 'site'

export interface Memory {
  id: string
  kind: MemoryKind
  title: string
  content: string
  /** site memories: the host they apply to ("taobao.com" also covers subdomains) */
  scope: string | null
  /**
   * pending: learned automatically, waiting for the user to confirm (review mode);
   * archived: merged into / replaced by another memory during tidying (kept for undo, never recalled)
   */
  status: 'active' | 'pending' | 'archived'
  pinned: boolean
  /** conversation it was learned in */
  source: { threadId: string; title: string } | null
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
  useCount: number
}

export interface MemoryInput {
  kind: MemoryKind
  title: string
  content: string
  scope?: string | null
  pinned?: boolean
}

/** Memories a message was answered with (shown under the user bubble). */
export interface MemoryRef {
  id: string
  title: string
  kind: MemoryKind
}

/**
 * One thing the background tidy-up did: merged several memories into one, let a newer one replace
 * an older contradicting one, retired an outdated one — or found a contradiction it can't decide.
 */
export interface MemoryMerge {
  id: string
  at: number
  kind: 'merge' | 'supersede' | 'expire' | 'conflict'
  /** the memory that remains (merge / supersede) */
  result: Memory | null
  /** the memories as they were before */
  sources: Memory[]
  /** why; for a conflict: the question put to the user */
  reason: string
  undoneAt: number | null
  /** conflicts: when the user decided */
  resolvedAt: number | null
}

/** One line of the daily journal: what the user did in one conversation on one day. */
export interface DayEntry {
  /** local date, YYYY-MM-DD */
  day: string
  threadId: string
  threadTitle: string
  text: string
  updatedAt: number
}

export interface MemorySettings {
  /** use memories in conversations at all */
  enabled: boolean
  /** after each reply, pick out things worth remembering */
  autoLearn: boolean
  /** automatically learned memories wait for confirmation */
  review: boolean
  /** keep a daily journal: one line per conversation per day */
  daily: boolean
  /** model for the background memory pass; null = the conversation's model */
  modelId: string | null
  /** turns without an explicit cue are looked at together once the conversation has been quiet this long */
  idleMinutes: number
  /** tidy memories in the background: merge duplicates, resolve contradictions, generalise */
  consolidate: boolean
}

export interface MemoryLearned {
  threadId: string
  batchId: string
  items: { id: string; title: string; op: 'add' | 'update' | 'delete'; pending?: boolean }[]
  /** every item waits for confirmation (review mode, or not backed by the user's own words) */
  pending: boolean
}

// ---------- MCP ----------
export type McpTransport = 'stdio' | 'http' | 'sse'

export interface McpServer {
  id: string
  name: string
  transport: McpTransport
  command?: string | null
  args?: string[] | null
  env?: Record<string, string> | null
  url?: string | null
  headers?: Record<string, string> | null
  enabled: boolean
}

export interface McpStatus {
  id: string
  state: 'disconnected' | 'connecting' | 'connected' | 'error'
  error?: string
  tools: { name: string; description?: string }[]
}

// ---------- Connectors ----------
export interface ConnectorDef {
  id: string
  name: string
  description: string
  icon: string
  auth: 'oauth' | 'token' | 'none'
  mcpUrl?: string
  tokenLabel?: string
  tokenHelp?: string
  oauth?: {
    authorizeUrl: string
    tokenUrl: string
    clientId?: string
    scopes: string[]
  }
  custom?: boolean
}

export interface ConnectorState {
  id: string
  connected: boolean
  enabled: boolean
  connectedAt?: number | null
  error?: string | null
}

// ---------- Plugins ----------
export interface PluginAction {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface PluginManifest {
  id: string
  name: string
  version?: string
  description?: string
  matches: string[]
  contentScript: string
  actions: PluginAction[]
}

export interface PluginInfo extends PluginManifest {
  enabled: boolean
  dir: string
  error?: string
}

// ---------- Macros ----------
export type MacroStepType = 'navigate' | 'click' | 'type' | 'select' | 'press' | 'wait' | 'scroll' | 'extract'

export interface MacroStep {
  id: string
  type: MacroStepType
  selectors?: string[]
  value?: string
  url?: string
  key?: string
  label?: string
  timeout?: number
}

export interface MacroParam {
  name: string
  description?: string
  default?: string
}

export interface Macro {
  id: string
  name: string
  description: string
  startUrl?: string
  params: MacroParam[]
  steps: MacroStep[]
  exposeAsTool: boolean
  createdAt: number
  updatedAt: number
}

export interface MacroRunResult {
  ok: boolean
  failedStep?: number
  error?: string
  extracted: Record<string, string>
}

// ---------- Tasks ----------
export interface Task {
  id: string
  name: string
  prompt: string
  modelId?: string | null
  cron?: string | null
  enabled: boolean
  createdAt: number
  lastRunAt?: number | null
  lastStatus?: TaskRunStatus | null
}

export type TaskRunStatus = 'queued' | 'running' | 'success' | 'error' | 'cancelled'

export interface TaskRun {
  id: string
  taskId: string
  threadId: string
  status: TaskRunStatus
  startedAt: number
  finishedAt?: number | null
  summary?: string | null
  error?: string | null
}

// ---------- Dev / traces ----------
export interface TraceEntry {
  id: string
  threadId: string
  runId: string
  kind: 'llm' | 'tool' | 'error'
  name: string
  input: string
  output: string
  durationMs: number
  tokens?: number | null
  createdAt: number
}

export interface Settings {
  theme: 'system' | 'light' | 'dark'
  devMode: boolean
  systemPrompt: string
  langsmithApiKeySet?: boolean
  langsmithProject?: string
  approvalTools: string[]
  browserSubagent: boolean
  /** first-run onboarding finished (or skipped) */
  onboarded: boolean
  /** Navo's own MCP server for external agents (Claude Code, Cursor, …) */
  mcpServer: McpServerSettings
  files: FilesSettings
  langfuse: LangfuseSettings
  memory: MemorySettings
}

export interface LangfuseSettings {
  enabled: boolean
  /** https://cloud.langfuse.com (EU), https://us.cloud.langfuse.com (US) or a self-hosted URL */
  baseUrl: string
  publicKey: string
  /** secret key lives in the keychain; this only says whether one is stored */
  secretKeySet?: boolean
  environment: string
  /** upload page screenshots in traces (off: replaced with a placeholder) */
  includeScreenshots: boolean
  /** resolved on "test connection", used to build trace links */
  projectId?: string | null
}

export interface McpServerSettings {
  enabled: boolean
  port: number
  /** allow external agents to send messages / run Navo's agent */
  allowRun: boolean
  /** allow creating / changing / deleting skills, MCP servers, connectors, models, conversations */
  allowWrite: boolean
  /** expose the user's memories (memory_* tools; writing also needs allowWrite). Off by default: they are personal */
  allowMemory: boolean
}

export interface McpServerCall {
  at: number
  tool: string
  ok: boolean
  ms: number
  summary: string
}

export interface McpServerStatus {
  running: boolean
  url: string | null
  error: string | null
  tools: { name: string; description: string; readOnly: boolean }[]
  calls: McpServerCall[]
}

// ---------- Files (upload + parsing)
export type FileEngine = 'builtin' | 'markitdown' | 'docling' | 'mineru'
export type FileStatus = 'queued' | 'parsing' | 'ready' | 'error'

export interface FileRecord {
  id: string
  name: string
  ext: string
  size: number
  kind: string | null
  status: FileStatus
  /** live progress message while parsing */
  progress: string | null
  error: string | null
  engine: FileEngine | null
  title: string | null
  units: number | null
  unitLabel: string | null
  chars: number | null
  warnings: string[]
  ocrPages: number[]
  createdAt: number
  parsedAt: number | null
  /** path the agent reads (virtual filesystem) */
  agentPath: string
}

export interface FileEngineStatus {
  id: FileEngine
  name: string
  description: string
  available: boolean
  /** why it isn't available / how to enable it */
  hint?: string
  local: boolean
}

export interface FilesSettings {
  defaultEngine: FileEngine
  ocr: boolean
  mineruTokenSet?: boolean
}

/** attachment summary stored with a user message */
export interface MessageAttachment {
  id: string
  name: string
  kind: string | null
  chars: number | null
}
