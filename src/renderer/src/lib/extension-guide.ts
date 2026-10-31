export const OPEN_EXTENSION_GUIDE = 'navo:extension-guide'

/** Opens the extension import guide (the one dialog lives in ExtensionGuideHost). */
export function openExtensionGuide(): void {
  window.dispatchEvent(new Event(OPEN_EXTENSION_GUIDE))
}
