/**
 * Injected into the agent isolated world while recording. Serialized with toString(), so it must be self-contained.
 * Depends on window.__agent (page runtime) for role/name helpers.
 */

export function recorderScript(): void {
  const w = window as any
  if (w.__agentRecorder) return
  const A = w.__agent
  const send = (e: unknown) => w.__agentBridge?.send('recorder', e)

  const INTERACTIVE =
    'a,button,input,select,textarea,summary,label,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[onclick],[contenteditable=true]'
  const dynamicId = (id: string) => /\d{4,}|[a-f0-9]{8,}|^[:_]|react|ember|uid/i.test(id)

  function unique(sel: string, el: Element): boolean {
    try {
      const all = document.querySelectorAll(sel)
      return all.length === 1 && all[0] === el
    } catch {
      return false
    }
  }

  function cssPath(el: Element): string {
    const parts: string[] = []
    let cur: Element | null = el
    while (cur && cur.nodeType === 1 && parts.length < 6) {
      const tag = cur.tagName.toLowerCase()
      if (cur.id && !dynamicId(cur.id)) {
        parts.unshift(`#${CSS.escape(cur.id)}`)
        break
      }
      const parent: Element | null = cur.parentElement
      if (!parent) {
        parts.unshift(tag)
        break
      }
      const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName)
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(cur) + 1})` : tag)
      const sel = parts.join(' > ')
      if (unique(sel, el)) return sel
      cur = parent
    }
    return parts.join(' > ')
  }

  function selectorsFor(el: Element): string[] {
    const out: string[] = []
    for (const attr of ['data-testid', 'data-test', 'data-qa', 'data-cy']) {
      const v = el.getAttribute(attr)
      if (v) out.push(`[${attr}="${CSS.escape(v)}"]`)
    }
    if (el.id && !dynamicId(el.id)) out.push(`#${CSS.escape(el.id)}`)
    const tag = el.tagName.toLowerCase()
    const name = el.getAttribute('name')
    if (name) {
      const s = `${tag}[name="${CSS.escape(name)}"]`
      if (unique(s, el)) out.push(s)
    }
    const aria = el.getAttribute('aria-label')
    if (aria) {
      const s = `${tag}[aria-label="${CSS.escape(aria)}"]`
      if (unique(s, el)) out.push(s)
    }
    const role = A.roleOf(el)
    const accName = A.nameOf(el)
    if (accName && accName.length < 60) out.push(`role=${role}[name="${accName}"]`)
    const txt = A.text((el as HTMLElement).innerText, 500)
    if (txt && txt.length < 40 && (tag === 'a' || tag === 'button' || role === 'button' || role === 'link')) out.push(`text=${txt}`)
    out.push(cssPath(el))
    return Array.from(new Set(out))
  }

  function target(e: Event): Element | null {
    const t = e.composedPath()[0] as Element
    if (!(t instanceof Element) || t.closest('[data-agent-overlay]')) return null
    return t.closest(INTERACTIVE) || t
  }

  const isText = (el: Element) =>
    (el.tagName === 'INPUT' && !['checkbox', 'radio', 'submit', 'button', 'reset', 'file', 'image'].includes((el as HTMLInputElement).type)) ||
    el.tagName === 'TEXTAREA' ||
    (el as HTMLElement).isContentEditable

  const label = (el: Element) => `${A.roleOf(el)} "${A.nameOf(el)}"`

  const onClick = (e: MouseEvent) => {
    const el = target(e)
    if (!el || isText(el) || el.tagName === 'SELECT' || el.tagName === 'OPTION') return
    send({ type: 'click', selectors: selectorsFor(el), label: label(el), url: location.href, t: Date.now() })
  }
  const onInput = (e: Event) => {
    const el = target(e)
    if (!el || !isText(el)) return
    const value = (el as HTMLElement).isContentEditable ? (el as HTMLElement).innerText : (el as HTMLInputElement).value
    const secret = (el as HTMLInputElement).type === 'password'
    send({ type: 'type', selectors: selectorsFor(el), value, secret, label: label(el), url: location.href, t: Date.now() })
  }
  const onChange = (e: Event) => {
    const el = target(e)
    if (!el) return
    if (el.tagName === 'SELECT') {
      const s = el as HTMLSelectElement
      send({
        type: 'select',
        selectors: selectorsFor(el),
        value: s.options[s.selectedIndex]?.text.trim() ?? s.value,
        label: label(el),
        url: location.href,
        t: Date.now(),
      })
    }
  }
  const onKey = (e: KeyboardEvent) => {
    if (!['Enter', 'Tab', 'Escape'].includes(e.key)) return
    const el = target(e)
    send({ type: 'press', key: e.key, selectors: el ? selectorsFor(el) : [], label: el ? label(el) : '', url: location.href, t: Date.now() })
  }

  document.addEventListener('click', onClick, true)
  document.addEventListener('input', onInput, true)
  document.addEventListener('change', onChange, true)
  document.addEventListener('keydown', onKey, true)

  w.__agentRecorder = {
    stop() {
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('input', onInput, true)
      document.removeEventListener('change', onChange, true)
      document.removeEventListener('keydown', onKey, true)
      delete w.__agentRecorder
    },
  }
}
