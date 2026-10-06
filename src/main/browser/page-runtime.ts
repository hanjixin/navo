/**
 * Runtime injected into every tab's isolated world (world 999, shared with the tab preload).
 * It must be self-contained: it is serialized with Function.prototype.toString().
 */

export function pageRuntime(): void {
  const w = window as any
  if (w.__agent) return

  let seq = 0
  const refs = new Map<string, WeakRef<Element>>()
  const elToRef = new WeakMap<Element, string>()

  const INTERACTIVE =
    'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])'

  function refFor(el: Element): string {
    let r = elToRef.get(el)
    if (!r) {
      r = `e${++seq}`
      elToRef.set(el, r)
      refs.set(r, new WeakRef(el))
    }
    return r
  }

  function resolve(ref: string): Element {
    const el = refs.get(ref)?.deref()
    if (!el || !el.isConnected) throw new Error(`元素 ${ref} 已失效，请重新调用 browser_snapshot`)
    return el
  }

  function visible(el: Element): boolean {
    const s = getComputedStyle(el)
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }

  function text(s: string | null | undefined, max = 80): string {
    const t = (s || '').replace(/\s+/g, ' ').trim()
    return t.length > max ? t.slice(0, max) + '…' : t
  }

  function roleOf(el: Element): string {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return 'link'
    if (tag === 'button' || tag === 'summary') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'input') {
      const t = (el as HTMLInputElement).type
      if (t === 'checkbox' || t === 'radio') return t
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button'
      return 'textbox'
    }
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if ((el as HTMLElement).isContentEditable) return 'textbox'
    return tag
  }

  function nameOf(el: Element): string {
    const aria = el.getAttribute('aria-label')
    if (aria) return text(aria)
    const labelledby = el.getAttribute('aria-labelledby')
    if (labelledby) {
      const l = document.getElementById(labelledby)
      if (l) return text(l.textContent)
    }
    const id = el.getAttribute('id')
    if (id) {
      const l = document.querySelector(`label[for="${CSS.escape(id)}"]`)
      if (l) return text(l.textContent)
    }
    const input = el as HTMLInputElement
    if (input.placeholder) return text(input.placeholder)
    if (el.tagName === 'IMG') return text((el as HTMLImageElement).alt)
    const t = text((el as HTMLElement).innerText || el.textContent)
    if (t) return t
    return text(el.getAttribute('title') || input.name || '')
  }

  const CHROME = 'header,nav,footer,aside,[role=banner],[role=navigation],[role=contentinfo],[role=complementary]'
  const FORM_CONTROL = 'input,textarea,select,[role=textbox],[role=combobox],[role=searchbox],[contenteditable=""],[contenteditable=true]'

  function describe(el: Element): string {
    const tag = el.tagName.toLowerCase()
    const role = roleOf(el)
    let line = `[${refFor(el)}] ${role} "${nameOf(el)}"`
    const input = el as HTMLInputElement
    if (role === 'textbox' || role === 'combobox' || role === 'searchbox') line += ` value="${text(input.value ?? (el as HTMLElement).innerText, 60)}"`
    if (role === 'checkbox' || role === 'radio') line += input.checked ? ' [checked]' : ''
    if (tag === 'select') {
      const opts = Array.from((el as HTMLSelectElement).options)
        .slice(0, 15)
        .map((o) => o.text.trim())
      line += ` options=${JSON.stringify(opts)}`
    }
    if ((el as HTMLButtonElement).disabled) line += ' [disabled]'
    if (tag === 'a') {
      const href = el.getAttribute('href') || ''
      if (href && !href.startsWith('javascript') && href !== '#') line += ` -> ${href.slice(0, 80)}`
    }
    return line
  }

  /**
   * Structured, budgeted page outline. Main content comes first and only the current + next screen
   * is included by default; links in headers/navs/footers are folded into a count (their form
   * controls — e.g. a search box — are kept). scope 'all' lifts the viewport limit.
   */
  function snapshot(opts: { scope?: 'viewport' | 'all'; maxChars?: number } = {}): string {
    const all = opts.scope === 'all'
    const max = opts.maxChars ?? (all ? 20000 : 6000)
    const vh = window.innerHeight || 800
    // "current + next screen" is measured from where the content starts: a long header / nav can push
    // <main> more than a screen down (small windows), and the page would otherwise look empty
    const mainEl = document.querySelector('main,article,[role="main"]')
    const mainTop = mainEl ? mainEl.getBoundingClientRect().top : 0
    const contentTop = mainTop > vh ? mainTop : 0
    const main: string[] = []
    const chrome: string[] = []
    let foldedLinks = 0
    let below = 0
    const seen = new Set<Element>()
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT)
    let node = walker.currentNode as Element | null
    while (node) {
      const el = node
      node = walker.nextNode() as Element | null
      if (seen.has(el) || !visible(el)) continue
      const tag = el.tagName.toLowerCase()
      const interactive = el.matches(INTERACTIVE)
      const heading = /^h[1-6]$/.test(tag)
      const para = tag === 'p' || tag === 'li' || tag === 'td' || tag === 'th' || tag === 'label' || tag === 'dd' || tag === 'blockquote'
      if (!interactive && !heading && !para) continue
      const r = el.getBoundingClientRect()
      const inChrome = !!el.closest(CHROME)
      // links in the chrome are only counted, and its form controls (a search box) are always worth
      // keeping — wherever they sit; everything else is limited to two screens
      const chromeLink = inChrome && interactive && !el.matches(FORM_CONTROL) && !(tag === 'button' && el.closest('form'))
      const chromeControl = inChrome && interactive && !chromeLink
      if (!all && !chromeLink && !chromeControl && r.top > (inChrome ? 0 : contentTop) + vh * 2) {
        if (interactive) below++
        continue
      }
      if (interactive) {
        seen.add(el)
        if (chromeLink) {
          foldedLinks++
          if (!all) continue
          chrome.push(describe(el))
          continue
        }
        const target = inChrome ? chrome : main
        const line = describe(el)
        // "## Title" immediately followed by a link with the same text → one line: "## [e4] link "Title" -> …"
        const prev = target[target.length - 1]
        const m = prev ? /^(#{1,6}) (.*)$/.exec(prev) : null
        if (m && m[2] === nameOf(el)) target[target.length - 1] = `${m[1]} ${line}`
        else target.push(line)
      } else if (heading) {
        ;(inChrome ? chrome : main).push(`${'#'.repeat(Number(tag[1]))} ${text((el as HTMLElement).innerText, 140)}`)
      } else if (!inChrome) {
        const own = text((el as HTMLElement).innerText, 200)
        if (own && !el.querySelector(INTERACTIVE) && !el.querySelector('p,li')) main.push(`  ${own}`)
      }
    }
    const pageH = Math.max(document.documentElement.scrollHeight, vh)
    const screen = Math.floor(window.scrollY / vh) + 1
    const screens = Math.max(1, Math.ceil(pageH / vh))
    const out: string[] = [`[第 ${screen}/${screens} 屏]`]
    let size = 0
    const push = (l: string) => {
      if (size > max) return false
      out.push(l)
      size += l.length + 1
      return true
    }
    // form controls in the chrome (search boxes) first, then main content
    for (const l of chrome) if (!/\] link /.test(l)) push(l)
    let truncated = false
    for (const l of main)
      if (!push(l)) {
        truncated = true
        break
      }
    if (all) for (const l of chrome) if (/\] link /.test(l)) push(l)
    const notes: string[] = []
    if (foldedLinks && !all) notes.push(`导航/页眉/页脚中有 ${foldedLinks} 个链接已折叠`)
    if (below) notes.push(`下方还有 ${below} 个可交互元素，可 browser_scroll 或 browser_snapshot({scope:'all'})`)
    if (truncated) notes.push('内容超出长度已截断')
    if (notes.length) out.push(`…(${notes.join('；')})`)
    return out.join('\n')
  }

  function scrollIntoView(el: Element): void {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior })
  }

  function center(ref: string): { x: number; y: number } {
    const el = resolve(ref)
    scrollIntoView(el)
    const r = el.getBoundingClientRect()
    flash(el)
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  }

  let overlay: HTMLDivElement | null = null
  function setControlled(on: boolean): void {
    if (on && !overlay) {
      overlay = document.createElement('div')
      overlay.setAttribute('data-agent-overlay', '')
      overlay.style.cssText =
        'position:fixed;inset:0;pointer-events:none;z-index:2147483647;box-shadow:inset 0 0 0 2px rgba(68,116,242,.9);transition:opacity .2s'
      document.documentElement.appendChild(overlay)
    } else if (!on && overlay) {
      overlay.remove()
      overlay = null
    }
  }

  function flash(el: Element): void {
    const r = el.getBoundingClientRect()
    const box = document.createElement('div')
    box.style.cssText = `position:fixed;left:${r.left - 3}px;top:${r.top - 3}px;width:${r.width + 6}px;height:${r.height + 6}px;border:2px solid #4474F2;border-radius:4px;background:rgba(68,116,242,.08);pointer-events:none;z-index:2147483647;transition:opacity .4s`
    document.documentElement.appendChild(box)
    setTimeout(() => (box.style.opacity = '0'), 500)
    setTimeout(() => box.remove(), 950)
  }

  function query(selectors: string[]): Element | null {
    for (const sel of selectors) {
      try {
        let el: Element | null = null
        if (sel.startsWith('text=')) {
          const needle = sel.slice(5)
          el =
            Array.from(document.querySelectorAll(INTERACTIVE + ',span,div,li,td')).find(
              (e) => text((e as HTMLElement).innerText, 500) === needle && visible(e),
            ) ?? null
        } else if (sel.startsWith('role=')) {
          const m = /^role=(\w+)\[name="(.*)"\]$/.exec(sel)
          if (m) el = Array.from(document.querySelectorAll(INTERACTIVE)).find((e) => roleOf(e) === m[1] && nameOf(e) === m[2] && visible(e)) ?? null
        } else if (sel.startsWith('xpath=')) {
          el = document.evaluate(sel.slice(6), document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as Element | null
        } else {
          el = document.querySelector(sel)
        }
        if (el && visible(el)) return el
      } catch {
        /* try next selector */
      }
    }
    return null
  }

  function extract(selector?: string, maxChars = 20000): string {
    const root = (selector ? document.querySelector(selector) : document.querySelector('main,article') || document.body) as HTMLElement | null
    if (!root) return ''
    const t = root.innerText.replace(/\n{3,}/g, '\n\n').trim()
    return t.length > maxChars ? t.slice(0, maxChars) + '\n…(已截断)' : t
  }

  function setValue(ref: string, value: string): void {
    const el = resolve(ref) as HTMLInputElement | HTMLSelectElement
    if (el.tagName === 'SELECT') {
      const sel = el as HTMLSelectElement
      const opt = Array.from(sel.options).find((o) => o.value === value || o.text.trim() === value)
      if (!opt) throw new Error(`选项不存在: ${value}`)
      sel.value = opt.value
    } else {
      const proto = Object.getPrototypeOf(el)
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function focus(ref: string, clear: boolean): void {
    const el = resolve(ref) as HTMLInputElement
    scrollIntoView(el)
    flash(el)
    el.focus()
    if (clear) {
      if ('select' in el && typeof el.select === 'function') el.select()
      else document.execCommand('selectAll')
    }
  }

  w.__agent = { snapshot, resolve, refFor, center, setControlled, query, extract, setValue, focus, nameOf, roleOf, visible, text }
}
