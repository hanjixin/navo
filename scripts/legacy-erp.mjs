// A small "legacy" ERP for fixed-flow tests: sign-in, element ids that change on every load, forms
// laid out in tables, search, export. GET /admin/v2 switches it to a redesigned version.
import { createServer } from 'node:http'

export function startErp(PORT, PASSWORD) {
  const BASE = `http://127.0.0.1:${PORT}`
  const exported = []
  let version = 1
  const rid = () => `x${Math.random().toString(36).slice(2, 8)}`
  const page = (title, body) =>
    `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title><style>body{font:14px SimSun,serif;margin:0}.bar{background:#1c3f8c;color:#fff;padding:6px 12px}.main{padding:16px}table{border-collapse:collapse}td{border:1px solid #999;padding:4px 8px}</style></head><body><div class="bar">XX 公司 ERP 管理系统 V3.2</div><div class="main">${body}</div></body></html>`
  const server = createServer((req, res) => {
    const url = new URL(req.url, BASE)
    const html = (s, headers = {}) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...headers }).end(s)
    const signedIn = /erp_session=ok/.test(req.headers.cookie ?? '')
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (url.pathname === '/admin/v2') return ((version = 2), res.writeHead(200).end('v2'))
      if (url.pathname === '/login' && req.method === 'POST') {
        const f = new URLSearchParams(body)
        if (f.get('u') !== 'admin' || f.get('p') !== PASSWORD) return html(page('登录失败', '<p>用户名或密码错误。<a href="/login">返回</a></p>'))
        return res.writeHead(302, { Location: '/home', 'Set-Cookie': 'erp_session=ok; Path=/' }).end()
      }
      if (url.pathname === '/login' || url.pathname === '/')
        return html(
          page(
            '登录',
            `<form method="post" action="/login"><table><tr><td>用户名</td><td><input id="${rid()}" name="u"></td></tr><tr><td>密码</td><td><input id="${rid()}" name="p" type="password"></td></tr></table><p><input type="submit" value="登 录"></p></form>`,
          ),
        )
      if (!signedIn) return res.writeHead(302, { Location: '/login' }).end()
      if (url.pathname === '/home')
        return html(
          page(
            '首页',
            `<table><tr><td><a href="/orders">订单管理</a></td><td><a href="#">库存管理</a></td><td><a href="#">财务报表</a></td></tr></table><p>欢迎您，admin。</p>`,
          ),
        )
      if (url.pathname === '/orders')
        return html(
          page(
            version === 1 ? '订单管理' : '订单中心',
            version === 1
              ? `<form action="/orders/result"><table><tr><td>订单号</td><td><input id="${rid()}" name="no"></td><td><input type="submit" value="查询"></td></tr></table></form>`
              : `<h3>订单中心 2.0</h3><div><form action="/orders/result"><input id="${rid()}" name="order_code" placeholder="输入单号"> <button type="submit">搜索订单</button></form></div>`,
          ),
        )
      if (url.pathname === '/orders/result') {
        const no = url.searchParams.get('no') ?? url.searchParams.get('order_code') ?? ''
        return html(
          page(
            '查询结果',
            `<table><tr><td>订单号</td><td>${no}</td></tr><tr><td>状态</td><td>已发货</td></tr></table><form action="/orders/export"><input type="hidden" name="no" value="${no}"><input type="submit" value="导出 Excel"></form>`,
          ),
        )
      }
      if (url.pathname === '/orders/export') {
        exported.push(url.searchParams.get('no'))
        return html(page('导出', `<p>订单 ${url.searchParams.get('no')} 已导出。</p>`))
      }
      res.writeHead(404).end()
    })
  }).listen(PORT)
  return { exported, close: () => server.close() }
}
