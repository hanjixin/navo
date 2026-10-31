const $ = (id) => document.getElementById(id)

async function render() {
  const s = await chrome.runtime.sendMessage({ t: 'status' })
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  $('code').hidden = s.state !== 'pairing'
  $('toggle').hidden = s.state !== 'linked' || !tab
  if (s.state === 'offline') $('status').textContent = '未连接。请打开 Navo，并在「设置 → 电脑操作」中开启「使用我的浏览器」。'
  if (s.state === 'pairing') {
    $('status').textContent = '请在 Navo 中确认这个配对码：'
    $('code').textContent = s.pairingCode
  }
  if (s.state === 'linked') {
    const handed = tab && s.handed.includes(tab.id)
    $('status').textContent = `已连接 Navo（${s.browser}）。` + (handed ? '这个标签页已交给 Navo。' : 'Navo 只能使用它自己打开的标签页，以及你交给它的标签页。')
    $('toggle').textContent = handed ? '收回这个标签页' : '把这个标签页交给 Navo'
    $('toggle').onclick = async () => {
      $('toggle').disabled = true
      await chrome.runtime.sendMessage({ t: handed ? 'revoke' : 'handover', tabId: tab.id })
      $('toggle').disabled = false
      void render()
    }
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.t === 'state') void render()
})
void render()
