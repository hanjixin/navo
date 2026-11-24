import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'
import { mainWindow } from './helpers.mjs'

const app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: mkdtempSync(join(tmpdir(), 'navo-template-teams-')) } })
try {
  const page = await mainWindow(app)
  await page.getByRole('link', { name: '智能体', exact: true }).click()
  await page.getByRole('heading', { name: 'Navo 助手' }).waitFor()
  const open = page.getByRole('button', { name: '从团队模板添加' })
  const dialog = page.getByRole('dialog')
  assert.equal(await page.getByRole('article').count(), 1)
  assert.equal(await dialog.count(), 0)

  await open.click()
  await dialog.getByRole('tab', { name: '项目协作团队' }).click()
  await dialog.getByRole('heading', { name: '会前准备助手' }).waitFor()
  assert.equal(await dialog.getByRole('heading', { name: '技术简报助手' }).count(), 0)
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(await page.getByRole('article').count(), 1)

  await open.click()
  await dialog.getByRole('article').filter({ hasText: '技术简报助手' }).getByRole('button', { name: '一键添加' }).click()
  await dialog.getByRole('button', { name: /已添加/ }).waitFor()
  assert.equal(await dialog.isVisible(), true, 'individual installation keeps the picker open for adding more agents')
  const list = () => page.evaluate(() => window.api.invoke('agents.list'))
  const first = (await list()).find((agent) => agent.templateId === 'tech-brief')
  await page.evaluate((profile) => window.api.invoke('agents.save', { ...profile, instructions: 'Custom instructions' }), first)

  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  await open.click()
  await dialog.getByRole('button', { name: '添加团队助手（1）' }).click()
  await dialog.waitFor({ state: 'hidden' })
  await page.getByRole('heading', { name: '研发周报助手' }).waitFor()
  await page.evaluate(() => window.api.invoke('agents.addTemplateTeam', 'engineering'))
  const profiles = await list()
  assert.equal(profiles.length, 3)
  assert.equal(profiles.find((agent) => agent.id === first.id).instructions, 'Custom instructions')
  await open.click()
  assert.equal(await dialog.getByRole('button', { name: '已全部添加' }).isDisabled(), true)
  console.log('PASS team picker, cancellation, individual and group installation, and deduplication')
} finally {
  await app.close()
}
