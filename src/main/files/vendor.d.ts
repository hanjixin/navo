// Type shims for packages that ship without declarations.
declare module '@joplin/turndown-plugin-gfm' {
  import type TurndownService from 'turndown'
  export const gfm: TurndownService.Plugin
  export const tables: TurndownService.Plugin
  export const strikethrough: TurndownService.Plugin
}
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs'
declare module '@mixmark-io/domino' {
  const domino: { createDocument(html?: string): Document }
  export default domino
}
