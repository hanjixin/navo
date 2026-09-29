import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

function dir(...p: string[]): string {
  const d = join(app.getPath('userData'), ...p)
  mkdirSync(d, { recursive: true })
  return d
}

export const paths = {
  get userData() {
    return app.getPath('userData')
  },
  get db() {
    return join(dir(), 'agent.db')
  },
  get checkpoints() {
    return join(dir(), 'checkpoints.db')
  },
  get skills() {
    return dir('skills')
  },
  get plugins() {
    return dir('plugins')
  },
  get memories() {
    return dir('memories')
  },
  get workspace() {
    return dir('workspace')
  },
  /** originals of uploaded files */
  get files() {
    return dir('files')
  },
  /** parsed Markdown, mounted read-only at /uploads/ for the agent */
  get uploads() {
    return dir('uploads')
  },
  get ocrCache() {
    return dir('ocr')
  },
}
