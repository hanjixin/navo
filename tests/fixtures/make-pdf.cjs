// Run with Electron: renders fixture HTML to a real (Chromium-printed) PDF.
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const out = process.argv[2]
const html = `<!doctype html><meta charset=utf-8><style>body{font-family:-apple-system,'PingFang SC',sans-serif;font-size:12px;margin:40px}h1{font-size:26px}h2{font-size:18px;margin-top:28px}table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px 8px}.pb{page-break-before:always}</style>
<h1>季度经营报告</h1>
<p>本报告总结了 2026 年第三季度的主要经营数据。收入同比增长 23%，毛利率保持在 41% 左右。</p>
<h2>一、核心指标</h2>
<ul><li>营业收入：1.28 亿元</li><li>新增客户：3,410 家</li><li>客户留存率：92.5%</li></ul>
<table><tr><th>地区</th><th>收入（万元）</th><th>同比</th></tr><tr><td>华东</td><td>5,200</td><td>+18%</td></tr><tr><td>华南</td><td>3,900</td><td>+31%</td></tr><tr><td>海外</td><td>1,150</td><td>+64%</td></tr></table>
<h2 class=pb>二、下季度计划</h2>
<p>Next quarter we will expand the partner program and launch the enterprise edition.</p>
<p>重点事项包括：渠道扩张、企业版发布、以及客服体系升级。</p>`
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false })
  await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  writeFileSync(out, await w.webContents.printToPDF({ pageSize: 'A4' }))
  app.quit()
})
