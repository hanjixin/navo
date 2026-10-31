/**
 * Dialog and file-chooser takeover shared by the built-in browser and tabs in the user's browser.
 * No Electron imports: the external-browser driver and the tests use it too.
 */

/**
 * Replaces alert/confirm/prompt in the page's main world while an agent drives the tab.
 * Native dialogs would block the page (and the agent) until a human clicks them.
 * alert is acknowledged, confirm/prompt follow `window.__navoDialogPolicy` (dismiss by default),
 * and every dialog is reported to the agent through a console marker.
 */
export const DIALOG_SHIM = `(() => {
  if (window.__navoShim) return; window.__navoShim = true;
  const o = { alert: window.alert, confirm: window.confirm, prompt: window.prompt }; window.__navoOrig = o;
  const rep = (type, message, answer) => { try { console.debug('__navo_dialog__' + JSON.stringify({ type, message: String(message ?? '').slice(0, 500), answer })) } catch (e) {} };
  window.alert = function (m) { rep('alert', m, null) };
  window.confirm = function (m) { const a = !!(window.__navoDialogPolicy && window.__navoDialogPolicy.confirm); rep('confirm', m, a); return a };
  window.prompt = function (m, d) { const p = window.__navoDialogPolicy; const a = p && typeof p.prompt === 'string' ? p.prompt : null; rep('prompt', m, a); return a };
})()`
export const RESTORE = `(() => { if (window.__navoOrig) { Object.assign(window, window.__navoOrig); delete window.__navoShim } })()`

const MARKER = '__navo_dialog__'

/** The page event for a dialog the shim answered; null for any other console output. */
export function dialogNotice(message: string): string | null {
  if (typeof message !== 'string' || !message.startsWith(MARKER)) return null
  try {
    const d = JSON.parse(message.slice(MARKER.length)) as { type: string; message: string; answer: unknown }
    const kind = d.type === 'alert' ? '提示框' : d.type === 'confirm' ? '确认框' : '输入框'
    const outcome =
      d.type === 'alert'
        ? '已关闭'
        : d.type === 'confirm'
          ? `已自动选择「${d.answer ? '确定' : '取消'}」`
          : d.answer == null
            ? '已取消'
            : `已填写「${String(d.answer)}」`
    const hint = d.type === 'alert' ? '' : '。如需不同的选择，请调用 browser_set_dialog_policy 设置后重试该操作'
    return `页面弹出${kind}：「${d.message}」，${outcome}${hint}`
  } catch {
    return null
  }
}

/** The page event for an intercepted file chooser. */
export function chooserNotice(mode: string): string {
  return `页面打开了文件选择框（${mode === 'selectMultiple' ? '可多选' : '单选'}）。请调用 browser_upload_file 并提供文件的绝对路径（无需 ref）。`
}
