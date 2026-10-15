// Evaluates fixed flows against a real model (the default model of your profile), on a local "legacy"
// ERP served here: sign-in, element ids that change on every load, search, export. The agent does it
// once with the model; it is kept as a flow; the flow replays without the model; the ERP is redesigned
// and the replay breaks; the agent repairs it; the updated flow replays without the model again.
// Runs on a copy of the profile database; nothing is stored.
//   node scripts/flow-eval.mjs [path/to/Navo/profile]
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { startErp } from './legacy-erp.mjs'

const src = process.argv[2] ?? join(homedir(), 'Library/Application Support/Navo')
const PORT = 38994
const BASE = `http://127.0.0.1:${PORT}`
const PASSWORD = 'navo-123'

const erp = startErp(PORT, PASSWORD)
const exported = erp.exported

const dir = mkdtempSync(join(tmpdir(), 'navo-eval-'))
for (const f of ['agent.db', 'agent.db-wal', 'agent.db-shm', 'Local State']) if (existsSync(join(src, f))) copyFileSync(join(src, f), join(dir, f))
const casesFile = join(dir, 'flow.json')
writeFileSync(
  casesFile,
  JSON.stringify({
    base: BASE,
    password: PASSWORD,
    prompt: `打开公司 ERP（${BASE}/login），用账号 admin、密码 ${PASSWORD} 登录，进入订单管理，查询订单 A-1001，然后点导出。这个以后每天都要做。`,
  }),
)
let failed = 0
const check = (c, msg) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${msg}`)
  if (!c) failed++
}
try {
  // a normally started process: Playwright would substitute a mock keychain and the API key could not be read
  await new Promise((resolve) => {
    // async, so the test site above keeps answering
    const child = spawn(createRequire(import.meta.url)('electron'), ['.'], {
      env: { ...process.env, AB_USER_DATA: dir, NAVO_FLOW_EVAL: casesFile },
      stdio: 'ignore',
    })
    const timer = setTimeout(() => child.kill(), 15 * 60_000)
    child.on('exit', () => (clearTimeout(timer), resolve()))
  })
  const o = JSON.parse(readFileSync(`${casesFile}.out.json`, 'utf8'))
  console.log(`model: ${o.model}\n`)
  if (o.error) console.log(`error: ${o.error}`)
  check(o.first?.ok && exported[0] === 'A-1001', `1. 第一次靠模型完成（${o.first?.modelCalls} 次模型调用，${((o.first?.ms ?? 0) / 1000).toFixed(0)}s）`)
  if (o.first?.finalText) console.log(`      ${o.first.finalText.replace(/\s+/g, ' ').slice(0, 160)}`)
  check(!!o.draft?.params?.some((p) => p.default === 'A-1001') && o.draft?.params?.some((p) => p.name === 'password'), `2. 固化：「${o.draft?.name}」`)
  for (const p of o.draft?.params ?? []) console.log(`      {{${p.name}}} ${p.description ?? ''}${p.default ? ` = ${p.default}` : ''}`)
  console.log(`      起始页 ${o.draft?.startUrl}`)
  for (const s of o.draft?.steps ?? []) console.log(`      - ${s}`)
  if (process.env.FLOW_EVAL_RAW) console.log(JSON.stringify(o.rawSteps, null, 1))
  check(
    o.replay?.ok && exported.includes('B-2002'),
    `3. 无模型回放（B-2002）${o.replay?.error ? ` — ${o.replay.error}` : ''}（${((o.replay?.ms ?? 0) / 1000).toFixed(1)}s）`,
  )
  check(
    o.repair?.repaired && exported.includes('C-3003'),
    `4. 改版后回放失败 → Agent 修复（C-3003，第 ${(o.repair?.failedStep ?? -1) + 1} 步）${o.repair?.error ? ` — ${o.repair.error}` : ''}（${((o.repair?.ms ?? 0) / 1000).toFixed(0)}s）`,
  )
  for (const s of o.repair?.steps ?? []) console.log(`      - ${s}`)
  check(
    o.replayAfterRepair?.ok && exported.includes('D-4004'),
    `5. 修复后的流程无模型回放（D-4004）${o.replayAfterRepair?.error ? ` — ${o.replayAfterRepair.error}` : ''}（${((o.replayAfterRepair?.ms ?? 0) / 1000).toFixed(1)}s）`,
  )
  console.log(`\nexports: ${exported.join(', ')}\nstats: ${JSON.stringify(o.stats)}`)
} finally {
  erp.close()
  rmSync(dir, { recursive: true, force: true }) // the copy holds your (encrypted) API keys
}
if (failed) process.exitCode = 1
