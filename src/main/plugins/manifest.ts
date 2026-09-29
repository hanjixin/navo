import { z } from 'zod'
import type { PluginManifest } from '@shared/types'

const ManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/, 'id 只能包含小写字母、数字和连字符'),
  name: z.string().min(1),
  version: z.string().optional(),
  description: z.string().optional(),
  matches: z.array(z.string()).min(1),
  contentScript: z.string().default('content.js'),
  actions: z
    .array(
      z.object({
        name: z.string().regex(/^[a-zA-Z0-9_]{1,40}$/, 'action 名称只能包含字母、数字和下划线'),
        description: z.string().min(1),
        parameters: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }),
      }),
    )
    .default([]),
})

export function validateManifest(raw: unknown): PluginManifest {
  return ManifestSchema.parse(raw) as PluginManifest
}

// Chrome-extension style match patterns, e.g. https://*.example.com/path*, *://host/*, <all_urls>
export function matchPattern(pattern: string, url: string): boolean {
  if (pattern === '<all_urls>') return /^(https?|file):/.test(url)
  const m = /^(\*|https?|file):\/\/([^/]*)(\/.*)?$/.exec(pattern)
  if (!m) return false
  const [, scheme, host, path = '/*'] = m
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  const proto = u.protocol.slice(0, -1)
  if (scheme === '*' ? !['http', 'https'].includes(proto) : scheme !== proto) return false
  if (host !== '*') {
    if (host.startsWith('*.')) {
      const base = host.slice(2)
      if (u.hostname !== base && !u.hostname.endsWith('.' + base)) return false
    } else if (u.host !== host && u.hostname !== host) return false
  }
  const re = new RegExp(
    '^' +
      path
        .split('*')
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$',
  )
  return re.test(u.pathname + u.search)
}
