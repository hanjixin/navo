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
  const selectorsFor = (el: Element): string[] => A.selectorsFor(el)

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
