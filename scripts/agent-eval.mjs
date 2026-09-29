// Evaluates Navo's agent on browser tasks against a real model (the default model of your profile).
// Tasks run on a local test site served here, so results are reproducible. Runs on a copy of the
// profile database; approvals are off (headless).
//   node scripts/agent-eval.mjs [path/to/Navo/profile] [--only name,name]
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null
const src = args.find((a) => !a.startsWith('--') && a !== only?.join(',')) ?? join(homedir(), 'Library/Application Support/Navo')
const PORT = 38990
const BASE = `http://127.0.0.1:${PORT}`

// ---------- the test site
const page = (title, body, script = '') =>
  `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title><style>body{font:15px system-ui;margin:24px;max-width:860px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 10px}.card{border:1px solid #ddd;padding:8px;margin:6px 0}</style></head><body>${body}<script>${script}</script></body></html>`
const PRODUCTS = [
  ['AirPods Pro 2', 1799],
  ['AirPods 4', 999],
  ['AirPods Max', 3999],
  ['AirPods 4 降噪款', 1399],
  ['AirPods 3（官翻）', 899],
  ['Beats Studio Buds', 899.5],
  ['Galaxy Buds 3', 1099],
]
const ITEMS = Array.from({ length: 15 }, (_, i) => `商品-${['甲', '乙', '丙', '丁', '戊'][i % 5]}${i + 1}`)
const ARTICLE =
  Array.from({ length: 40 }, (_, i) => `<p>第 ${i + 1} 段：这是一段关于城市更新与社区治理的普通说明文字，用来让文章足够长。</p>`).join('') +
  '<p>本报告由研究组撰写，正式发布日期为 2025 年 3 月 14 日，数据截至 2024 年底。</p>' +
  Array.from({ length: 20 }, (_, i) => `<p>补充 ${i + 1}：更多背景信息。</p>`).join('')

const site = createServer((req, res) => {
  const url = new URL(req.url, BASE)
  const html = (s) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(s)
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (url.pathname === '/shop') {
      const q = url.searchParams.get('q')
      const hits = q ? PRODUCTS.filter(([n]) => n.toLowerCase().includes(q.toLowerCase())) : []
      return html(
        page(
          '测试商店',
          `<h1>测试商店</h1><form action="/shop"><input name="q" placeholder="搜索商品" value="${q ?? ''}"><button>搜索</button></form>` +
            (q
              ? `<p>共 ${hits.length} 个结果</p>` + hits.map(([n, p]) => `<div class="card"><b>${n}</b> <span>¥${p}</span></div>`).join('')
              : '<p>请输入关键词搜索。</p>'),
        ),
      )
    }
    if (url.pathname === '/form' && req.method === 'POST') {
      const f = new URLSearchParams(body)
      const good = f.get('name') === '张三' && f.get('email') === 'zhangsan@example.com' && f.get('agree') === 'on'
      return html(page('提交结果', good ? '<h1>报名成功</h1><p>确认编号：REG-4821</p>' : `<h1>提交失败</h1><p>信息不完整：${[...f.keys()].join(',')}</p>`))
    }
    if (url.pathname === '/form')
      return html(
        page(
          '活动报名',
          '<h1>活动报名</h1><form method="post"><p><label>姓名 <input name="name"></label></p><p><label>邮箱 <input name="email" type="email"></label></p><p><label><input type="checkbox" name="agree"> 我同意活动条款</label></p><button>提交报名</button></form>',
        ),
      )
    if (url.pathname === '/list') {
      const p = Math.max(1, Math.min(3, Number(url.searchParams.get('page') ?? 1)))
      const rows = ITEMS.slice((p - 1) * 5, p * 5)
      return html(
        page(
          `商品列表 第${p}页`,
          `<h1>商品列表</h1><ol start="${(p - 1) * 5 + 1}">${rows.map((r) => `<li>${r}</li>`).join('')}</ol><p>第 ${p} / 3 页 ${p < 3 ? `<a href="/list?page=${p + 1}">下一页</a>` : ''}</p>`,
        ),
      )
    }
    if (url.pathname === '/modal')
      return html(
        page(
          '优惠活动',
          `<h1>优惠活动</h1><button id="claim" onclick="document.getElementById('code').textContent='优惠码：SAVE20'">领取优惠</button><p id="code"></p>
           <div id="overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center">
             <div style="background:#fff;padding:24px;border-radius:6px"><p>本站使用 Cookie 改善体验。</p><button onclick="document.getElementById('overlay').remove()">我知道了</button></div></div>`,
        ),
      )
    if (url.pathname === '/article') return html(page('城市更新研究报告', `<h1>城市更新研究报告</h1>${ARTICLE}`))
    if (url.pathname === '/weather')
      return html(
        page(
          '天气查询',
          '<h1>天气查询</h1><label>城市 <select id="city"><option value="">请选择</option><option>北京</option><option>上海</option><option>成都</option><option>广州</option></select></label><p id="out">请选择城市</p>',
          "const t={北京:'12°C',上海:'18°C',成都:'23°C',广州:'27°C'};document.getElementById('city').onchange=e=>{document.getElementById('out').textContent=e.target.value?e.target.value+' 当前温度 '+t[e.target.value]:'请选择城市'}",
        ),
      )
    if (url.pathname === '/table')
      return html(
        page(
          '地区销售',
          '<h1>2025 年地区销售</h1><table><tr><th>地区</th><th>销售额（万元）</th></tr><tr><td>华北</td><td>1,250</td></tr><tr><td>华东</td><td>3,870</td></tr><tr><td>华南</td><td>2,940</td></tr><tr><td>西南</td><td>1,120</td></tr></table>',
        ),
      )
    res.writeHead(404).end()
  })
}).listen(PORT)

/** check: every regex must match the final answer */
const CASES = [
  { name: '比价', prompt: `在 ${BASE}/shop 搜索「AirPods」，告诉我最便宜的那款叫什么、多少钱。`, check: [/AirPods 3/, /899(?!\.)/] },
  { name: '填表', prompt: `打开 ${BASE}/form ，用姓名「张三」、邮箱 zhangsan@example.com 报名（需要同意条款），提交后告诉我确认编号。`, check: [/REG-4821/] },
  {
    name: '翻页采集',
    prompt: `${BASE}/list 是一个分页的商品列表。把所有页的商品都看一遍，告诉我一共有多少个商品，第 12 个叫什么。`,
    check: [/15/, /商品-乙12/],
  },
  { name: '弹窗', prompt: `打开 ${BASE}/modal ，点击「领取优惠」按钮，告诉我拿到的优惠码。`, check: [/SAVE20/] },
  { name: '长文抽取', prompt: `打开 ${BASE}/article ，这份报告的正式发布日期是哪天？`, check: [/2025\s*年\s*3\s*月\s*14\s*日|2025-03-14/] },
  { name: '下拉选择', prompt: `在 ${BASE}/weather 里选择城市「成都」，告诉我显示的温度。`, check: [/23\s*°?\s*C|23 ?度/] },
  { name: '表格', prompt: `打开 ${BASE}/table ，哪个地区的销售额最高？是多少？`, check: [/华东/, /3,?870/] },
].filter((c) => !only || only.includes(c.name))

// ---------- run in a normally started Navo (Playwright's mock keychain can't read the API key)
const dir = mkdtempSync(join(tmpdir(), 'navo-eval-'))
for (const f of ['agent.db', 'agent.db-wal', 'agent.db-shm', 'Local State']) if (existsSync(join(src, f))) copyFileSync(join(src, f), join(dir, f))
const casesFile = join(dir, 'cases.json')
writeFileSync(casesFile, JSON.stringify({ cases: CASES.map((c) => ({ prompt: c.prompt, timeoutMs: 240_000 })) }))
try {
  // async: the test site above lives in this process and must keep answering while Navo runs
  const child = spawn(createRequire(import.meta.url)('electron'), ['.'], {
    env: { ...process.env, AB_USER_DATA: dir, NAVO_AGENT_EVAL: casesFile },
    stdio: 'ignore',
  })
  const killer = setTimeout(() => child.kill(), 45 * 60_000)
  await new Promise((resolve) => child.on('exit', resolve))
  clearTimeout(killer)
  const { model, results } = JSON.parse(readFileSync(`${casesFile}.out.json`, 'utf8'))
  console.log(`model: ${model}\n`)
  let pass = 0
  let totalMs = 0
  let totalCalls = 0
  CASES.forEach((c, i) => {
    const r = results[i]
    const ok = !r.error && !r.timedOut && c.check.every((re) => re.test(r.finalText))
    if (ok) pass++
    totalMs += r.ms
    totalCalls += r.toolCalls.length
    const why = r.error ? `error: ${r.error}` : r.timedOut ? 'timed out' : ok ? '' : `answer didn't match ${c.check.map(String).join(' ')}`
    console.log(
      `${ok ? 'PASS' : 'FAIL'} ${c.name} — ${(r.ms / 1000).toFixed(1)}s, ${r.toolCalls.length} tool calls${r.toolErrors ? `, ${r.toolErrors} failed` : ''}${why ? ` — ${why}` : ''}`,
    )
    console.log(`      tools: ${r.toolCalls.join(' → ') || '—'}`)
    console.log(`      answer: ${r.finalText.replace(/\s+/g, ' ').slice(0, 200) || '—'}`)
  })
  console.log(
    `\n${pass}/${CASES.length} tasks pass · avg ${(totalMs / CASES.length / 1000).toFixed(1)}s · avg ${(totalCalls / CASES.length).toFixed(1)} tool calls`,
  )
  if (pass < CASES.length) process.exitCode = 1
} finally {
  site.close()
  rmSync(dir, { recursive: true, force: true }) // the copy holds your (encrypted) API keys
}
