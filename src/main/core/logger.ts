const buffer: string[] = []
const MAX = 2000
let sink: ((line: string) => void) | null = null

function write(level: string, args: unknown[]): void {
  const text = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? (a.stack ?? a.message) : JSON.stringify(a))).join(' ')
  const line = `${new Date().toISOString()} ${level} ${text}`
  buffer.push(line)
  if (buffer.length > MAX) buffer.shift()
  ;(level === 'ERROR' ? console.error : console.info)(line)
  sink?.(line)
}

export const log = {
  info: (...a: unknown[]) => write('INFO', a),
  warn: (...a: unknown[]) => write('WARN', a),
  error: (...a: unknown[]) => write('ERROR', a),
  lines: () => [...buffer],
  setSink: (fn: (line: string) => void) => {
    sink = fn
  },
}
