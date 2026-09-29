/**
 * The app's own window (not a browser-tab WebContentsView, which Playwright also lists as a page and
 * which may well contain a <nav> of its own). Fresh profiles start in onboarding; suites skip it
 * unless they test it.
 */
export async function mainWindow(app, { onboarding = false } = {}) {
  const isMain = (p) => /\/renderer\/index\.html|localhost:\d+\/?(#|$)/.test(p.url())
  for (let i = 0; i < 100; i++) {
    const found = app.windows().find(isMain)
    if (found) {
      await found.waitForFunction(() => !!window.api && !!document.querySelector('nav, [aria-label="首次设置"]'))
      if (!onboarding && (await found.$('[aria-label="首次设置"]'))) {
        await found.evaluate(() => window.api.invoke('settings.set', { onboarded: true }))
        await found.reload()
        await found.waitForFunction(() => !!window.api && !!document.querySelector('nav'))
      }
      return found
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('main window not found')
}
