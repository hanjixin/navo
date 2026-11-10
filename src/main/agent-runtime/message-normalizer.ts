/** Model text is never executable. These records explain a protocol leak, not a tool request. */
export interface UnexecutedTextToolCall {
  name: string
  args: Record<string, unknown>
}

export interface RuntimeTextDiagnostic {
  protocol: 'dsml'
  code: 'unexecuted_tool_call' | 'malformed_tool_markup' | 'truncated_tool_markup' | 'tool_markup_limit'
  executed: false
  calls: UnexecutedTextToolCall[]
}

export interface NormalizedRuntimeText {
  text: string
  diagnostics: RuntimeTextDiagnostic[]
}

const MAX_BLOCK = 64 * 1024
const MAX_TAG = 1024
const MAX_VALUE = 16 * 1024
const MAX_CALLS = 16
const MAX_PARAMETERS = 32
const MAX_DIAGNOSTICS = 32
const PREFIXES = ['<||dsml||', '</||dsml||']
const NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const TAG = /^<\s*(\/?)\s*[|｜]\s*[|｜]\s*DSML\s*[|｜]\s*[|｜]\s*([A-Za-z_][A-Za-z0-9_]*)\b([^>]*)>/i
const CLOSE_PARAMETER = /<\s*\/\s*[|｜]\s*[|｜]\s*DSML\s*[|｜]\s*[|｜]\s*parameter\s*>/i
const ANY_MARKER = /<\s*\/?\s*[|｜]\s*[|｜]\s*DSML\s*[|｜]\s*[|｜]/i

interface Tag {
  closing: boolean
  name: string
  attributes: string
  length: number
}

function readTag(text: string): Tag | null {
  const match = TAG.exec(text)
  return match ? { closing: !!match[1], name: match[2].toLowerCase(), attributes: match[3], length: match[0].length } : null
}

function attributes(text: string): Record<string, string> | null {
  const result: Record<string, string> = Object.create(null)
  while (text.trim()) {
    const match = /^\s+([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(text)
    if (!match || Object.hasOwn(result, match[1]) || UNSAFE_KEYS.has(match[1])) return null
    result[match[1]] = match[2] ?? match[3]
    text = text.slice(match[0].length)
  }
  return result
}

function safeJson(value: unknown, depth = 0): boolean {
  if (depth > 32) return false
  if (typeof value === 'number') return Number.isFinite(value)
  if (!value || typeof value !== 'object') return true
  if (Array.isArray(value)) return value.every((item) => safeJson(item, depth + 1))
  return Object.entries(value).every(([key, item]) => !UNSAFE_KEYS.has(key) && safeJson(item, depth + 1))
}

/** A deliberately small grammar: calls → invoke → parameter. No XML entities, scripts, or expressions. */
function parseCalls(raw: string): { calls: UnexecutedTextToolCall[]; limited?: boolean } | null {
  let remaining = raw.trim()
  const root = readTag(remaining)
  if (!root || root.closing || !['calls', 'invoke'].includes(root.name)) return null
  const wrapped = root.name === 'calls'
  if (wrapped) {
    if (root.attributes.trim()) return null
    remaining = remaining.slice(root.length).trimStart()
  }
  const calls: UnexecutedTextToolCall[] = []
  while (remaining) {
    const opening = readTag(remaining)
    if (!opening) return null
    if (wrapped && opening.closing && opening.name === 'calls') {
      if (opening.attributes.trim() || remaining.slice(opening.length).trim() || !calls.length) return null
      return { calls }
    }
    if (opening.closing || opening.name !== 'invoke') return null
    if (calls.length === MAX_CALLS) return { calls: [], limited: true }
    const callAttributes = attributes(opening.attributes)
    if (!callAttributes || Object.keys(callAttributes).length !== 1 || !NAME.test(callAttributes.name ?? '')) return null
    remaining = remaining.slice(opening.length).trimStart()
    const args: Record<string, unknown> = Object.create(null)
    let closed = false
    while (remaining) {
      const parameter = readTag(remaining)
      if (!parameter) return null
      if (parameter.closing && parameter.name === 'invoke') {
        if (parameter.attributes.trim()) return null
        remaining = remaining.slice(parameter.length).trimStart()
        closed = true
        break
      }
      if (parameter.closing || parameter.name !== 'parameter') return null
      if (Object.keys(args).length === MAX_PARAMETERS) return { calls: [], limited: true }
      const props = attributes(parameter.attributes)
      if (
        !props ||
        !NAME.test(props.name ?? '') ||
        UNSAFE_KEYS.has(props.name) ||
        Object.hasOwn(args, props.name) ||
        Object.keys(props).some((key) => key !== 'name' && key !== 'string') ||
        (props.string !== undefined && props.string !== 'true' && props.string !== 'false')
      )
        return null
      remaining = remaining.slice(parameter.length)
      const close = CLOSE_PARAMETER.exec(remaining)
      if (!close) return null
      const value = remaining.slice(0, close.index)
      if (value.length > MAX_VALUE) return { calls: [], limited: true }
      if (ANY_MARKER.test(value)) return null
      if (props.string === 'true') args[props.name] = value
      else {
        try {
          const parsed: unknown = JSON.parse(value)
          if (!safeJson(parsed)) return null
          args[props.name] = parsed
        } catch {
          return null
        }
      }
      remaining = remaining.slice(close.index + close[0].length).trimStart()
    }
    if (!closed) return null
    calls.push({ name: callAttributes.name, args })
    if (!wrapped) return remaining ? null : { calls }
  }
  return null
}

function cleanPrefix(text: string): string {
  return text.replace(/\s/g, '').replace(/｜/g, '|').toLowerCase()
}

function possibleMarker(text: string): boolean {
  const clean = cleanPrefix(text)
  return PREFIXES.some((prefix) => prefix.startsWith(clean) || clean.startsWith(prefix))
}

function recognizedMarker(text: string): boolean {
  const clean = cleanPrefix(text)
  return PREFIXES.some((prefix) => clean.startsWith(prefix))
}

interface ProtocolBlock {
  root: string
  raw: string
  tag: string
  limited: boolean
}

/**
 * Incremental text boundary for adapters. push() returns only append-safe UI text;
 * finish() returns the full final text plus diagnostics that the adapter must surface.
 * A diagnostic must never be sent to a tool dispatcher or treated as an approval.
 */
export class RuntimeTextStream {
  private text = ''
  private diagnostics: RuntimeTextDiagnostic[] = []
  private candidate = ''
  private block: ProtocolBlock | null = null
  private fence: { char: string; count: number } | null = null
  private inline = 0
  private delimiter: { char: string; count: number; lineStart: boolean } | null = null
  private closingFence = false
  private indent = 0
  private escaped = false
  private finished = false

  push(delta: string): string {
    if (this.finished) throw new Error('Runtime text stream is already finished')
    const before = this.text.length
    for (const char of delta) this.consume(char)
    return this.text.slice(before)
  }

  finish(): NormalizedRuntimeText {
    if (!this.finished) {
      this.finished = true
      if (this.block) this.report(this.block.limited ? 'tool_markup_limit' : 'truncated_tool_markup')
      else if (this.candidate) {
        if (recognizedMarker(this.candidate) || /^<\/?\|\|d/i.test(cleanPrefix(this.candidate))) this.report('truncated_tool_markup')
        else this.text += this.candidate
      }
      this.candidate = ''
      this.block = null
    }
    return { text: this.text, diagnostics: structuredClone(this.diagnostics) }
  }

  private report(code: RuntimeTextDiagnostic['code'], calls: UnexecutedTextToolCall[] = []): void {
    if (this.diagnostics.length < MAX_DIAGNOSTICS) this.diagnostics.push({ protocol: 'dsml', code, executed: false, calls })
  }

  private position(char: string): void {
    if (char === '\n') this.indent = 0
    else if (char === ' ' && this.indent >= 0) this.indent++
    else if (char !== '\r') this.indent = -1
  }

  private consume(char: string): void {
    if (this.block) {
      this.consumeBlock(char)
      this.position(char)
      return
    }
    if (this.candidate) {
      this.candidate += char
      if (!possibleMarker(this.candidate)) {
        const literal = this.candidate
        this.candidate = ''
        // Reprocess after the first '<' so code spans and a second candidate retain their meaning.
        this.text += literal[0]
        this.position(literal[0])
        for (const next of literal.slice(1)) this.consume(next)
        return
      }
      if (this.candidate.length > MAX_TAG) {
        if (recognizedMarker(this.candidate)) this.block = { root: 'calls', raw: '', tag: '', limited: true }
        else this.text += this.candidate
        this.candidate = ''
        return
      }
      if (char === '>' && recognizedMarker(this.candidate)) {
        const tag = readTag(this.candidate)
        if (tag && !tag.closing && ['calls', 'invoke', 'parameter'].includes(tag.name)) {
          this.block = { root: tag.name, raw: this.candidate, tag: '', limited: false }
        } else this.report('malformed_tool_markup')
        this.candidate = ''
      }
      this.position(char)
      return
    }
    if (this.delimiter) {
      if (char === this.delimiter.char) {
        this.delimiter.count++
        this.text += char
        this.position(char)
        return
      }
      const delimiter = this.delimiter
      this.delimiter = null
      if (this.fence) {
        if (delimiter.lineStart && delimiter.char === this.fence.char && delimiter.count >= this.fence.count && /\s/.test(char)) this.closingFence = true
      } else if (!this.inline && delimiter.lineStart && delimiter.count >= 3) this.fence = { char: delimiter.char, count: delimiter.count }
      else if (delimiter.char === '`') {
        if (!this.inline) this.inline = delimiter.count
        else if (this.inline === delimiter.count) this.inline = 0
      }
    }
    if (this.closingFence) {
      if (char === '\n') {
        this.fence = null
        this.closingFence = false
      } else if (!/\s/.test(char)) this.closingFence = false
    }
    if (this.escaped) {
      this.escaped = false
      this.text += char
      this.position(char)
      return
    }
    if (char === '\\' && !this.fence && !this.inline) this.escaped = true
    if (char === '`' || char === '~') {
      this.delimiter = { char, count: 1, lineStart: this.indent >= 0 && this.indent <= 3 }
    } else if (char === '<' && !this.fence && !this.inline) {
      this.candidate = char
      return
    }
    this.text += char
    this.position(char)
  }

  private consumeBlock(char: string): void {
    const block = this.block!
    if (!block.limited) {
      if (block.raw.length >= MAX_BLOCK) {
        block.limited = true
        block.raw = ''
      } else block.raw += char
    }
    if (char === '<') block.tag = char
    else if (block.tag) {
      block.tag += char
      if (!possibleMarker(block.tag) || block.tag.length > MAX_TAG) block.tag = ''
      else if (char === '>') {
        const tag = readTag(block.tag)
        block.tag = ''
        if (tag?.closing && tag.name === block.root) {
          if (block.limited) this.report('tool_markup_limit')
          else {
            const parsed = parseCalls(block.raw)
            this.report(parsed?.limited ? 'tool_markup_limit' : parsed ? 'unexecuted_tool_call' : 'malformed_tool_markup', parsed?.calls)
          }
          this.block = null
        }
      }
    }
  }
}

export function normalizeRuntimeText(text: string): NormalizedRuntimeText {
  const stream = new RuntimeTextStream()
  stream.push(text)
  return stream.finish()
}
