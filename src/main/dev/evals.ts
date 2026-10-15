import { app } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import type { Memory } from '@shared/types'
import { agent } from '../agent/agent-service'
import { describeStep } from '../flows/flows-core'
import { flows } from '../flows/flows'
import type { LearnTurn } from '../learning/scheduler'
import { memory } from '../memory/memory-service'
import { diffLines, judgeMessages, normalize, parseJudge } from '../monitor/monitor-core'
import { createChatModel, resolveModel } from '../models/registry'
import { recorder } from '../recorder/recorder-service'
import { skillEvolution } from '../skills/evolution'

/**
 * Real-model evaluations (scripts/memory-eval.mjs, scripts/agent-eval.mjs). They run in a normally
 * started app so the real keychain decrypts the API key; results go to `<cases>.out.json`.
 */

/** Automatic-learning dry runs: nothing is stored. Runs before the rest of the app starts. */
export async function runMemoryEval(file: string): Promise<void> {
  const { cases } = JSON.parse(readFileSync(file, 'utf8')) as { cases: { ex: Parameters<typeof memory.dryRun>[0]; existing: Memory[]; tidy?: Memory[] }[] }
  const results = []
  for (const c of cases) {
    const started = Date.now()
    // tidy cases: what a consolidation pass would do to this set of memories
    if (c.tidy) {
      results.push(
        await memory.dryPlan(c.tidy).then(
          (r) => ({ ...r, journal: null, ms: Date.now() - started }),
          (e: Error) => ({ error: e.message }),
        ),
      )
      continue
    }
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

/** Skill coach dry runs: what it would change for a stretch of conversation, and what the gate decides. */
export async function runSkillEval(file: string): Promise<void> {
  const { cases } = JSON.parse(readFileSync(file, 'utf8')) as { cases: { used: { id: string; content: string }[]; turns: LearnTurn[] }[] }
  const results = []
  for (const c of cases) {
    const started = Date.now()
    results.push(
      await skillEvolution.dryRun(c.used, c.turns).then(
        (r) => ({ ...r, ms: Date.now() - started }),
        (e: Error) => ({ error: e.message }),
      ),
    )
  }
  writeFileSync(`${file}.out.json`, JSON.stringify({ model: resolveModel(null).model, results }, null, 2))
  app.exit(0)
}

/**
 * Fixed flows end to end (scripts/flow-eval.mjs): the agent does a task once with the model, it is
 * kept as a flow, replayed without the model, then (after the site's redesign) repaired and replayed.
 */
export async function runFlowEval(file: string): Promise<void> {
  const { prompt, base, password } = JSON.parse(readFileSync(file, 'utf8')) as { prompt: string; base: string; password: string }
  const out: Record<string, unknown> = { model: resolveModel(null).model }
  const save = () => writeFileSync(`${file}.out.json`, JSON.stringify(out, null, 2))
  const assistantTurns = async (threadId: string) =>
    (await agent.threadState(threadId).catch(() => null))?.messages.filter((m) => m.role === 'assistant').length ?? 0
  try {
    const t = agent.createThread(null, { title: 'eval: 固定流程' })
    let started = Date.now()
    const r = await agent.send_(t.id, prompt, [], { headless: true })
    out.first = { ok: !r.error && !r.aborted, error: r.error, finalText: r.finalText, modelCalls: await assistantTurns(t.id), ms: Date.now() - started }
    out.traceInfo = flows.traceInfo(t.id)
    started = Date.now()
    const draft = await flows.draft(t.id)
    out.rawSteps = draft.steps
    out.draft = {
      name: draft.name,
      description: draft.description,
      startUrl: draft.startUrl,
      params: draft.params,
      steps: draft.steps.map(describeStep),
      ms: Date.now() - started,
    }
    const m = flows.save(draft)
    // the parameter the model made of the order number gets the new one; the password is filled in
    const params = (no: string) =>
      Object.fromEntries(draft.params.map((p) => [p.name, p.name === 'password' ? password : p.default === 'A-1001' ? no : (p.default ?? '')]))
    const run = async (no: string, repair: boolean) => {
      const s = Date.now()
      const res = await flows.run(m.id, params(no), repair)
      return { ...res, ms: Date.now() - s, version: flows.versions(m.id)[0]?.version, steps: recorder.get(m.id).steps.map(describeStep) }
    }
    out.replay = await run('B-2002', false)
    save()
    await fetch(`${base}/admin/v2`)
    out.repair = await run('C-3003', true)
    save()
    out.replayAfterRepair = await run('D-4004', false)
    out.stats = flows.stats()[m.id]
  } catch (e) {
    out.error = (e as Error).message
  }
  save()
  app.exit(0)
}

/** Monitor judgments (scripts/monitor-eval.mjs): does the change meet the condition? Runs before the rest of the app. */
export async function runMonitorEval(file: string): Promise<void> {
  const { cases } = JSON.parse(readFileSync(file, 'utf8')) as {
    cases: { url: string; focus?: string; condition?: string; prev: string; cur: string }[]
  }
  const results = []
  for (const c of cases) {
    const started = Date.now()
    const prev = normalize(c.prev)
    const cur = normalize(c.cur)
    const { added, removed } = diffLines(prev, cur)
    try {
      const res = await createChatModel(null).invoke(judgeMessages({ ...c, prev, cur, added, removed }))
      const text = typeof res.content === 'string' ? res.content : (res.content as { text?: string }[]).map((b) => b.text ?? '').join('')
      results.push({ verdict: parseJudge(text), raw: text.slice(0, 300), ms: Date.now() - started })
    } catch (e) {
      results.push({ error: (e as Error).message })
    }
  }
  writeFileSync(`${file}.out.json`, JSON.stringify({ model: resolveModel(null).model, results }, null, 2))
  app.exit(0)
}
