import { execFile } from 'node:child_process'
import type { AgentRuntimeInfo, AgentRuntimeKind, AgentRuntimeProfile, AgentRuntimeStatus } from '@shared/agent-runtime'
import { db, kv } from '../core/db'
import { emit } from '../core/ipc'
import { shellPath } from '../core/shell-env'
import { BuiltinRuntimeAdapter } from './builtin'
import { ExternalRuntimeAdapter } from './external'
import { PiRuntimeAdapter } from './pi'
import { ClaudeRuntimeDriver, validateClaudeArgs } from './drivers/claude'
import { DshRuntimeDriver, validateDshArgs } from './drivers/dsh'
import { CodexRuntimeDriver, validateCodexArgs } from './drivers/codex'
import type { AgentRuntime, ExternalRuntimeDriver, RuntimeCallbacks } from './types'

const defaults: AgentRuntimeProfile[] = [
  { id: 'builtin', kind: 'builtin', name: 'Navo · DeepAgents', enabled: true, command: '', args: [] },
  { id: 'pi', kind: 'pi', name: 'Pi Coding Agent', enabled: false, command: 'pi', args: [] },
  { id: 'claude', kind: 'claude', name: 'Claude Code', enabled: false, command: 'claude', args: [] },
  { id: 'dsh', kind: 'dsh', name: 'DeepSeek Harness', enabled: false, command: 'dsh', args: [] },
  { id: 'codex', kind: 'codex', name: 'Codex', enabled: false, command: 'codex', args: [] },
]
const builtinCapabilities = {
  navoTools: true,
  nativeTools: true,
  approvals: true,
  images: true,
  resume: true,
  fork: true,
  tokenStreaming: true,
  requiresNavoModel: true,
  workspaceTools: false,
  browserSubagent: true,
}
const validators = { claude: validateClaudeArgs, dsh: validateDshArgs, codex: validateCodexArgs }

export function validateRuntimeProfile(input: AgentRuntimeProfile): AgentRuntimeProfile {
  const base = defaults.find((item) => item.id === input?.id)
  if (!base || base.kind !== input.kind) throw new Error('Unknown agent runtime')
  if (base.kind === 'builtin') return structuredClone(base)
  if (base.kind === 'pi') return { ...structuredClone(base), enabled: input.enabled === true, command: '', args: [] }
  const string = (value: unknown, label: string, max: number, required = false): string => {
    if (value != null && typeof value !== 'string') throw new Error(`Invalid runtime ${label}`)
    const text = (value as string | undefined)?.trim() ?? ''
    if ((required && !text) || text.length > max || text.includes('\0')) throw new Error(`Invalid runtime ${label}`)
    return text
  }
  if (typeof input.enabled !== 'boolean' || !Array.isArray(input.args) || input.args.length > 64) throw new Error('Invalid runtime configuration')
  const args = input.args.map((arg) => {
    if (typeof arg !== 'string' || arg.includes('\0') || arg.length > 4096) throw new Error('Invalid runtime argument')
    return arg
  })
  validators[base.kind](args)
  const profile: AgentRuntimeProfile = {
    id: base.id,
    kind: base.kind,
    name: string(input.name, 'name', 100, true),
    enabled: input.enabled,
    command: string(input.command, 'executable', 4096, true),
    args,
    model: string(input.model, 'model', 512) || undefined,
    provider: string(input.provider, 'provider', 512) || undefined,
  }
  if (profile.enabled && profile.kind === 'dsh' && (!profile.model || !profile.provider)) throw new Error('DeepSeek Harness requires a provider and model')
  return profile
}

/** Business services use this boundary without knowing vendor process protocols. */
export class RuntimeRegistry {
  private builtin: AgentRuntime | null = null
  private pi: AgentRuntime | null = null
  private external = new Map<string, AgentRuntime>()
  private drivers = new Map<AgentRuntimeKind, ExternalRuntimeDriver>(
    [new ClaudeRuntimeDriver(), new DshRuntimeDriver(), new CodexRuntimeDriver()].map((driver) => [driver.kind, driver]),
  )

  list(): AgentRuntimeInfo[] {
    return defaults.map((base) => this.info(base.id))
  }

  info(id: string): AgentRuntimeInfo {
    const base = defaults.find((item) => item.id === id)
    if (!base) throw new Error('Unknown agent runtime')
    const stored = kv.get<AgentRuntimeProfile>(`runtime.profile:${id}`, base)
    const profile = validateRuntimeProfile(stored)
    return {
      profile,
      capabilities: {
        ...(base.kind === 'builtin'
          ? builtinCapabilities
          : base.kind === 'pi'
            ? { ...builtinCapabilities, nativeTools: false, fork: false, requiresNavoModel: true, workspaceTools: true, browserSubagent: false }
            : this.drivers.get(base.kind)!.capabilities),
      },
    }
  }

  save(input: AgentRuntimeProfile): AgentRuntimeInfo {
    const profile = validateRuntimeProfile(input)
    kv.set(`runtime.profile:${profile.id}`, profile)
    emit('runtimes.changed')
    return this.info(profile.id)
  }

  capture(id = 'builtin'): AgentRuntimeProfile {
    const { profile } = this.info(id)
    if (!profile.enabled) throw new Error('Agent runtime is disabled')
    return structuredClone(profile)
  }

  bind(threadId: string, profile: AgentRuntimeProfile): void {
    const row = this.row(threadId)
    if (row.runtime_config || row.runtime_id !== 'builtin') throw new Error('A conversation cannot change its agent runtime')
    const snapshot = validateRuntimeProfile(profile)
    db().prepare('UPDATE threads SET runtime_id = ?, runtime_config = ? WHERE id = ?').run(snapshot.id, JSON.stringify(snapshot), threadId)
  }

  private row(threadId: string): { runtime_id: string; runtime_config: string | null } {
    const row = db().prepare('SELECT runtime_id, runtime_config FROM threads WHERE id = ?').get(threadId) as
      { runtime_id: string; runtime_config: string | null } | undefined
    if (!row) throw new Error('Conversation does not exist')
    return row
  }

  profile(threadId: string): AgentRuntimeProfile {
    const row = this.row(threadId)
    const current = this.info(row.runtime_id || 'builtin').profile
    const snapshot = row.runtime_config ? validateRuntimeProfile(JSON.parse(row.runtime_config)) : current
    if (snapshot.id !== current.id) throw new Error('Agent runtime configuration does not match conversation')
    return { ...snapshot, enabled: current.enabled }
  }

  get(threadId: string, callbacks: RuntimeCallbacks): AgentRuntime {
    const profile = this.profile(threadId)
    if (profile.kind === 'builtin') return (this.builtin ??= new BuiltinRuntimeAdapter(callbacks))
    if (profile.kind === 'pi') return (this.pi ??= new PiRuntimeAdapter(callbacks))
    let runtime = this.external.get(threadId)
    if (!runtime) {
      runtime = new ExternalRuntimeAdapter(threadId, profile, this.drivers.get(profile.kind)!, callbacks, () => this.external.delete(threadId))
      this.external.set(threadId, runtime)
    }
    return runtime
  }

  async pendingApprovals(callbacks: RuntimeCallbacks): ReturnType<AgentRuntime['pendingApprovals']> {
    // Reading persisted external history invalidates stale requests from disconnected MCP channels.
    const external: Awaited<ReturnType<AgentRuntime['pendingApprovals']>> = []
    const rows = db().prepare("SELECT id FROM threads WHERE runtime_id NOT IN ('builtin','pi')").all() as { id: string }[]
    for (const row of rows) external.push(...(await this.get(row.id, callbacks).pendingApprovals()))
    const pi = await (this.pi ??= new PiRuntimeAdapter(callbacks)).pendingApprovals()
    if (!db().prepare("SELECT 1 FROM threads WHERE runtime_id = 'builtin' LIMIT 1").get()) return [...pi, ...external]
    const runtime = (this.builtin ??= new BuiltinRuntimeAdapter(callbacks))
    const pending = await runtime.pendingApprovals()
    return [
      ...pi,
      ...external,
      ...pending.filter((item) => {
        const row = db().prepare('SELECT runtime_id FROM threads WHERE id = ?').get(item.threadId) as { runtime_id: string } | undefined
        return row?.runtime_id === 'builtin'
      }),
    ]
  }

  async probe(id: string): Promise<AgentRuntimeStatus> {
    const { profile } = this.info(id)
    if (profile.kind === 'builtin' || profile.kind === 'pi')
      return { available: true, version: profile.kind === 'pi' ? 'Bundled Pi Core' : 'Bundled DeepAgents' }
    return new Promise((resolve) => {
      execFile(
        profile.command,
        [...profile.args, '--version'],
        { env: { ...process.env, PATH: shellPath() }, timeout: 8000, maxBuffer: 64 * 1024, windowsHide: true },
        (error, stdout) => {
          if (error) resolve({ available: false, error: error.code === 'ENOENT' ? 'Executable not found' : 'Version check failed or timed out' })
          else resolve({ available: true, version: stdout.trim().slice(0, 200) || 'Executable available' })
        },
      )
    })
  }

  refresh(): void {
    this.builtin?.refresh()
    this.pi?.refresh()
    for (const runtime of this.external.values()) runtime.refresh()
  }

  shutdown(): void {
    this.builtin?.shutdown()
    this.pi?.shutdown()
    for (const runtime of this.external.values()) runtime.shutdown()
  }
}

export const runtimeRegistry = new RuntimeRegistry()
