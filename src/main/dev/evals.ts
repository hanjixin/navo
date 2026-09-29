import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import type { Memory } from '@shared/types'
import { agent } from '../agent/agent-service'
import { memory } from '../memory/memory-service'
import { resolveModel } from '../models/registry'

/**
 * Real-model evaluations (scripts/memory-eval.mjs, scripts/agent-eval.mjs). They run in a normally
 * started app so the real keychain decrypts the API key; results go to `<cases>.out.json`.
 */

/** Automatic-learning dry runs: nothing is stored. Runs before the rest of the app starts. */
export async function runMemoryEval(file: string): Promise<void> {
  const { cases } = JSON.parse(readFileSync(file, 'utf8')) as { cases: { ex: Parameters<typeof memory.dryRun>[0]; existing: Memory[] }[] }
  const results = []
  for (const c of cases) {
    const started = Date.now()
    results.push(
      await memory.dryRun(c.ex, c.existing).then(
        (r) => ({ ...r, ms: Date.now() - started }),
        (e: Error) => ({ error: e.message }),
      ),
    )
  }
  writeFileSync(`${file}.out.json`, JSON.stringify({ model: resolveModel(null).model, results }, null, 2))
  app.exit(0)
}

/** Browser tasks end to end: each case in a new conversation, approvals off (headless). */
export async function runAgentEval(file: string): Promise<void> {
  const { cases } = JSON.parse(readFileSync(file, 'utf8')) as { cases: { prompt: string; timeoutMs?: number }[] }
  const results = []
  for (const c of cases) {
    const t = agent.createThread(null, { title: `eval: ${c.prompt.slice(0, 30)}` })
    const started = Date.now()
    const timer = setTimeout(() => agent.stop(t.id), c.timeoutMs ?? 180_000)
    const r = await agent.send_(t.id, c.prompt, [], { headless: true }).catch((e: Error) => ({ finalText: '', error: e.message, aborted: false }))
    clearTimeout(timer)
    const msgs = (await agent.threadState(t.id).catch(() => null))?.messages ?? []
    const calls = msgs.flatMap((m) => m.toolCalls ?? []).map((x) => x.name)
    results.push({
      finalText: r.finalText,
      error: 'error' in r ? r.error : undefined,
      timedOut: !!r.aborted,
      ms: Date.now() - started,
      toolCalls: calls,
      toolErrors: msgs.filter((m) => m.role === 'tool' && m.status === 'error').length,
    })
    // partial results, so a long run can be followed (and survives a crash)
    writeFileSync(`${file}.progress.json`, JSON.stringify(results, null, 2))
  }
  writeFileSync(`${file}.out.json`, JSON.stringify({ model: resolveModel(null).model, results }, null, 2))
  app.exit(0)
}
