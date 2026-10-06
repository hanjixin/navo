// Skills that improve with use: usage tracking, automatic small fixes (versioned, undoable), suggestions
// for big changes / new skills / shared skills, experience → skills, safety checks, and the UI.
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mainWindow } from './helpers.mjs'
import { startMock } from './mock-llm.mjs'

const out = process.argv[2] ?? tmpdir()
const profile = mkdtempSync(join(tmpdir(), 'ab-profile-'))
const home = mkdtempSync(join(tmpdir(), 'ab-home-'))
// a shared (read-only) skill, as another agent would have installed it
mkdirSync(join(home, '.agents/skills/shared-report'), { recursive: true })
const SHARED = '---\nname: shared-report\ndescription: 团队共享的月报写法\n---\n\n# 月报\n\n1. 汇总本月数据。\n2. 发给团队。\n'
writeFileSync(join(home, '.agents/skills/shared-report/SKILL.md'), SHARED)

const WEEKLY =
  '---\nname: weekly-report\ndescription: 写周报并提交\n---\n\n# 周报\n\n1. 打开 OA 的「周报」页面。\n2. 按「本周完成 / 下周计划」填写。\n3. 提交给直属上级。\n'

const mock = startMock(38988)
const app = await electron.launch({ args: ['.'], env: { ...process.env, HOME: home, AB_USER_DATA: profile, AB_MEMORY_IDLE_MS: '300' } })
const page = await mainWindow(app)
const api = (m, ...a) => page.evaluate(([m, a]) => window.api.invoke(m, ...a), [m, a])
const ok = (c, msg) => {
  console.log(`${c ? 'PASS' : 'FAIL'} ${msg}`)
  if (!c) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await page.evaluate(() => {
  window.__events = []
  window.__evolved = []
  window.api.on('chat.event', (e) => window.__events.push(e))
  window.api.on('skills.evolved', (e) => window.__evolved.push(e))
})
const runAndWait = async (threadId, text) => {
  const from = (await page.evaluate(() => window.__events)).length
  await api('chat.send', threadId, text)
  for (let i = 0; i < 160; i++) {
    if ((await page.evaluate(() => window.__events)).slice(from).some((e) => e.type === 'run_end' && e.threadId === threadId)) return
    await sleep(250)
  }
}
const evolved = () => page.evaluate(() => window.__evolved)
/** waits for the next skills.evolved event after `n` (the coach runs once the conversation is quiet) */
const nextEvolved = async (n, ms = 8000) => {
  for (let i = 0; i < ms / 100; i++) {
    const e = await evolved()
    if (e.length > n) return e[n]
    await sleep(100)
  }
  return null
}
/** waits until the coach has been asked `n` times in total */
const reflected = async (n, ms = 8000) => {
  for (let i = 0; i < ms / 100 && mock.reflections.length < n; i++) await sleep(100)
  await sleep(500)
  return mock.reflections.length >= n
}
const skillFile = (name) => join(profile, 'skills', name, 'SKILL.md')
const read = (name) => (existsSync(skillFile(name)) ? readFileSync(skillFile(name), 'utf8') : null)

try {
  const p = await api('providers.save', { type: 'openai-compatible', name: 'Mock', baseURL: mock.url, apiKey: 'x' })
  const m = await api('models.save', { providerId: p.id, model: 'mock-1', displayName: 'Mock', supportsTools: true, supportsVision: false })
  const run = async (text) => {
    const t = await api('threads.create', m.id)
    await runAndWait(t.id, text)
    return t
  }

  await api('skills.save', 'weekly-report', WEEKLY)
  ok((await api('skills.versions', 'weekly-report')).length === 1, 'saving a skill records its first version')

  // ---------- used, then corrected → small fix applied by itself
  let n = (await evolved()).length
  const t1 = await run('[read:/skills/weekly-report/SKILL.md] 按周报的 Skill 写一下 [sk-correct]')
  const e1 = await nextEvolved(n)
  ok(e1?.kind === 'patched' && e1.skill === 'weekly-report' && e1.version === 2, 'a skill that was used and corrected is patched automatically')
  ok(read('weekly-report').includes('## 经验与注意事项\n\n- 提交前要抄送王经理'), 'the lesson is appended to the notes section of SKILL.md')
  let versions = await api('skills.versions', 'weekly-report')
  ok(
    versions[0].source === 'agent-patch' && versions[0].threadId === t1.id && versions[0].reason.includes('抄送'),
    'the change is versioned with its reason and conversation',
  )
  let stats = await api('skills.stats')
  ok(stats['weekly-report']?.uses === 1 && stats['weekly-report'].corrected === 1 && stats['weekly-report'].autoPatches === 1, 'use and outcome are recorded')
  await page.waitForSelector('text=已改进 Skill', { timeout: 3000 }).catch(() => null)
  ok(!!(await page.$('text=已改进 Skill')), 'the user is told, with a way to undo')

  await api('skills.rollback', 'weekly-report', 1)
  ok(
    read('weekly-report') === WEEKLY && (await api('skills.versions', 'weekly-report'))[0].source === 'rollback',
    'rolling back restores the earlier text as a new version',
  )

  // ---------- a big change → suggestion, applied only after approval
  n = (await evolved()).length
  await run('[read:/skills/weekly-report/SKILL.md] 再写一次周报 [sk-big]')
  const e2 = await nextEvolved(n)
  let proposals = await api('skills.proposals')
  ok(
    e2?.kind === 'proposed' && proposals.length === 1 && proposals[0].kind === 'patch' && read('weekly-report') === WEEKLY,
    'a large change is only suggested; the skill stays as it is',
  )

  // ---------- hostile content never reaches a skill
  const r0 = mock.reflections.length
  n = (await evolved()).length
  await run('[read:/skills/weekly-report/SKILL.md] 看看这个页面再写周报 [sk-poison]')
  ok(await reflected(r0 + 1), 'coach consulted')
  ok(
    (await evolved()).length === n && read('weekly-report') === WEEKLY && (await api('skills.proposals')).length === 1,
    'a note that ships data to an unvisited address is dropped',
  )

  // ---------- UI: suggestion with diff, approve
  await page.evaluate(() => (window.location.hash = '#/skills'))
  await page.waitForSelector('[data-testid=skill-proposal]', { timeout: 5000 })
  await page.getByRole('button', { name: '查看改动' }).click()
  await page.waitForSelector('[data-diff=add]', { timeout: 3000 })
  ok((await page.$$('[data-diff=add]')).length >= 4 && (await page.$$('[data-diff=del]')).length === 0, 'the suggestion shows what would be added')
  await sleep(500)
  await page.screenshot({ path: join(out, 'skill-proposal.png') })
  await page.getByRole('button', { name: '批准并应用' }).click()
  await page.waitForSelector('[data-testid=skill-proposal]', { state: 'detached', timeout: 3000 }).catch(() => null)
  ok(
    read('weekly-report').includes('季度末的周报') && (await api('skills.versions', 'weekly-report'))[0].source === 'agent-proposal',
    'approving applies it as a new version',
  )

  // ---------- the agent's own tools
  await run('[skillnote:weekly-report] 核对一下金额格式')
  ok(read('weekly-report').includes('- 金额统一保留两位小数'), 'skill_note: the agent records a lesson during a run')
  const tw = await run('[writeskill] 直接改文件')
  const wmsg = (await api('threads.state', tw.id)).messages.find((x) => x.role === 'tool')
  ok(
    !existsSync(skillFile('hacked')) && /不能直接改写/.test(wmsg?.content ?? ''),
    'skill files are read-only to the agent (changes go through the skill tools)',
  )
  await run('[autosave] 整理一下会议纪要')
  ok(
    !existsSync(skillFile('unprompted-notes')) && (await api('skills.proposals')).some((x) => x.skill === 'unprompted-notes' && x.kind === 'create'),
    'navo_save_skill without the user asking becomes a suggestion',
  )
  await run('[asksave] 帮我写一个整理会议纪要的 skill')
  ok(existsSync(skillFile('asked-notes')), 'navo_save_skill saves directly when the user asked for a skill')
  await api('skills.resolveProposal', (await api('skills.proposals')).find((x) => x.skill === 'unprompted-notes').id, false)

  // ---------- a shared read-only skill → improved local copy, as a suggestion
  const ext = (await api('skills.list')).find((s) => s.name === 'shared-report')
  n = (await evolved()).length
  await run(`[read:/ext/${ext.id.slice(4)}/SKILL.md] 按共享的月报 Skill 写 [sk-correct]`)
  const e3 = await nextEvolved(n)
  proposals = await api('skills.proposals')
  const fork = proposals.find((x) => x.kind === 'fork')
  ok(
    e3?.kind === 'proposed' && fork?.skill === 'shared-report' && readFileSync(join(home, '.agents/skills/shared-report/SKILL.md'), 'utf8') === SHARED,
    'a shared skill is never modified: the fix is suggested as a local copy',
  )
  await api('skills.resolveProposal', fork.id, true)
  ok(read('shared-report')?.includes('提交前要抄送王经理'), 'approving creates the improved local copy (which takes precedence)')

  // ---------- experience → a new skill: suggested the first time, created once it has proved itself
  n = (await evolved()).length
  await run('[multistep] 比一下这几家的价格 [sk-new]')
  const e4 = await nextEvolved(n)
  ok(e4?.kind === 'proposed' && !existsSync(skillFile('price-compare')), 'a multi-step task done once: the new skill is only suggested')
  n = (await evolved()).length
  await run('[multistep] 再比一下另外几家的价格 [sk-new]')
  const e5 = await nextEvolved(n)
  versions = await api('skills.versions', 'price-compare')
  ok(
    e5?.kind === 'created' && existsSync(skillFile('price-compare')) && versions[0]?.source === 'experience',
    'done successfully again in another conversation: the skill is created automatically',
  )
  ok(!(await api('skills.proposals')).some((x) => x.skill === 'price-compare'), 'the earlier suggestion is closed')

  // ---------- site experience → a skill that follows the tips
  for (const [title, content] of [
    ['先关弹窗', '首页会先弹出登录框，关掉后再操作。'],
    ['搜索入口', '搜索框在页面顶部中间。'],
    ['改地址', '要从「我的订单」进入才能改收货地址。'],
  ])
    await api('memory.save', { kind: 'site', scope: 'shop.example.org', title, content })
  const site = read('site-shop-example-org')
  ok(!!site && ['先关弹窗', '搜索入口', '改地址'].every((t) => site.includes(`**${t}**`)), 'three tips for one website are organised into a skill')
  await api('memory.save', { kind: 'site', scope: 'shop.example.org', title: '发票', content: '发票在订单详情页底部申请。' })
  ok(read('site-shop-example-org').includes('**发票**') && (await api('skills.versions', 'site-shop-example-org')).length === 2, 'the skill follows new tips')
  await api('skills.save', 'site-shop-example-org', read('site-shop-example-org') + '\n我自己补充的一行。\n')
  await api('memory.save', { kind: 'site', scope: 'shop.example.org', title: '客服', content: '在线客服入口在右下角。' })
  ok(
    read('site-shop-example-org').includes('我自己补充的一行') && !read('site-shop-example-org').includes('**客服**'),
    'once the user has edited it, it is no longer overwritten',
  )

  // ---------- switched off
  const s = await api('settings.get')
  await api('settings.set', { skills: { ...s.skills, selfImprove: false } })
  const r1 = mock.reflections.length
  await run('[read:/skills/weekly-report/SKILL.md] 再写一次 [sk-correct]')
  await sleep(1800)
  ok(mock.reflections.length === r1, 'self-improvement off: the coach is not consulted')
  await api('settings.set', { skills: { ...s.skills, selfImprove: true } })

  // ---------- UI: usage on the list, version history with diff
  await page.evaluate(() => (window.location.hash = '#/chat'))
  await page.evaluate(() => (window.location.hash = '#/skills'))
  await page.waitForSelector('text=weekly-report', { timeout: 5000 })
  await page.getByText('weekly-report', { exact: true }).first().click()
  ok(await page.isVisible('text=/用过 \\d+ 次/'), 'the list shows how often a skill was used')
  await page.getByRole('button', { name: '版本' }).click()
  await page.waitForSelector('[data-testid=skill-version]', { timeout: 3000 })
  const shown = (await page.$$('[data-testid=skill-version]')).length
  ok(shown === (await api('skills.versions', 'weekly-report')).length && shown >= 4, `version history lists every state (${shown})`)
  await sleep(500)
  await page.screenshot({ path: join(out, 'skill-history.png') })
} catch (e) {
  await page.screenshot({ path: join(out, 'skill-fail.png') }).catch(() => null)
  console.log('FAIL exception', e)
  process.exitCode = 1
} finally {
  await app.close()
  mock.server.close()
}
