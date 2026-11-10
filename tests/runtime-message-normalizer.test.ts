import { describe, expect, it } from 'vitest'
import { normalizeRuntimeText, RuntimeTextStream } from '../src/main/agent-runtime/message-normalizer'

const invoke = (name: string, parameters: string) => `<｜｜DSML｜｜invoke name="${name}">${parameters}</｜｜DSML｜｜invoke>`
const parameter = (name: string, value: string, string = true) => `<｜｜DSML｜｜parameter name="${name}" string="${string}">${value}</｜｜DSML｜｜parameter>`
const calls = (body = invoke('Bash', parameter('command', 'echo "hello"'))) => `<｜｜DSML｜｜calls>${body}</｜｜DSML｜｜calls>`

describe('runtime text protocol normalization', () => {
  it('preserves ordinary prose and separates leaked tool syntax as unexecuted diagnostics', () => {
    const result = normalizeRuntimeText(`我试一下。\n${calls()}\n请检查配置。`)
    expect(result.text).toBe('我试一下。\n\n请检查配置。')
    expect(result.diagnostics).toEqual([
      { protocol: 'dsml', code: 'unexecuted_tool_call', executed: false, calls: [{ name: 'Bash', args: { command: 'echo "hello"' } }] },
    ])
  })

  it('accepts whitespace and ASCII delimiter variants, with strict JSON values', () => {
    const source = `< | | DSML | | calls>\n< | | DSML | | invoke name='browser_navigate'>\n< | | DSML | | parameter name="url" string="true">https://example.test?a=1&b=2</ | | DSML | | parameter>\n< | | DSML | | parameter name='options' string='false'>{"timeout":10,"wait":true}</ | | DSML | | parameter>\n</ | | DSML | | invoke>\n</ | | DSML | | calls>`
    const result = normalizeRuntimeText(source)
    expect(result.text).toBe('')
    expect(result.diagnostics[0].calls).toEqual([
      { name: 'browser_navigate', args: { url: 'https://example.test?a=1&b=2', options: { timeout: 10, wait: true } } },
    ])
  })

  it('handles several calls and never treats the diagnostics as executed actions', () => {
    const result = normalizeRuntimeText(calls(invoke('read_file', parameter('path', '/workspace/a')) + invoke('Bash', parameter('command', 'rm -rf /'))))
    expect(result.diagnostics[0].calls.map((call) => call.name)).toEqual(['read_file', 'Bash'])
    expect(result.diagnostics[0].executed).toBe(false)
  })

  it.each([
    invoke('Bash', parameter('command', 'one') + parameter('command', 'two')),
    invoke('Bash', parameter('__proto__', '{}', false)),
    invoke('Bash', parameter('value', '{"constructor":{}}', false)),
    invoke('Bash', parameter('command', 'process.exit()', false)),
    invoke('Bash', parameter('value', '1e999', false)),
    invoke('Bash', '<｜｜DSML｜｜parameter name="value" string="yes">x</｜｜DSML｜｜parameter>'),
    '<｜｜DSML｜｜invoke name="Bash" name="other"></｜｜DSML｜｜invoke>',
    '<｜｜DSML｜｜invoke name="Bash">unexpected prose</｜｜DSML｜｜invoke>',
    '<｜｜DSML｜｜calls></｜｜DSML｜｜calls>',
  ])('rejects malformed or ambiguous arguments without recovering partial executable data', (source) => {
    const result = normalizeRuntimeText(source)
    expect(result.text).toBe('')
    expect(result.diagnostics).toMatchObject([{ code: 'malformed_tool_markup', executed: false, calls: [] }])
  })

  it.each(['<｜｜DSML｜｜calls>', '<｜｜DSML｜｜invoke name="Bash">', '<｜｜DSML｜｜', '<｜｜DSML', '<｜｜DSM', '<｜｜D'])(
    'flags truncated protocol and hides it',
    (source) => {
      expect(normalizeRuntimeText(`Before ${source}`)).toMatchObject({ text: 'Before ', diagnostics: [{ code: 'truncated_tool_markup', calls: [] }] })
    },
  )

  it('preserves fenced and inline code examples', () => {
    const examples = [`\`\`\`xml\n${calls()}\n\`\`\``, `~~~text\n${calls()}\n~~~`, `Example: \`${calls()}\``, `Example: \`\`${calls()}\`\``]
    for (const source of examples) expect(normalizeRuntimeText(source)).toEqual({ text: source, diagnostics: [] })
  })

  it('recognizes a real leak after a code fence ends and handles escaped syntax', () => {
    const example = `\`\`\`xml\n${calls()}\n\`\`\`\n`
    expect(normalizeRuntimeText(example + calls())).toMatchObject({ text: example, diagnostics: [{ code: 'unexecuted_tool_call' }] })
    expect(normalizeRuntimeText('Escaped: \\<｜｜DSML｜｜calls>')).toEqual({ text: 'Escaped: \\<｜｜DSML｜｜calls>', diagnostics: [] })
  })

  it('bounds parameters, calls and total protocol block storage', () => {
    for (const source of [
      calls(invoke('Bash', parameter('command', 'x'.repeat(16 * 1024 + 1)))),
      calls(invoke('Bash', '').repeat(17)),
      calls('x'.repeat(70 * 1024)),
    ]) {
      const result = normalizeRuntimeText(source + 'Done')
      expect(result.text).toBe('Done')
      expect(result.diagnostics).toMatchObject([{ code: 'tool_markup_limit', calls: [] }])
    }
  })
})

describe('incremental runtime text filtering', () => {
  it('never emits a DSML marker or parameters across any two-chunk split', () => {
    const source = `Checking.\n${calls()}\nDone.`
    for (let split = 0; split <= source.length; split++) {
      const stream = new RuntimeTextStream()
      const emitted = stream.push(source.slice(0, split)) + stream.push(source.slice(split))
      expect(emitted).toBe('Checking.\n\nDone.')
      expect(stream.finish()).toEqual(normalizeRuntimeText(source))
    }
  })

  it('filters a character at a time while retaining fenced examples and later prose', () => {
    const code = `\`\`\`xml\n${calls()}\n\`\`\`\n`
    const source = `Intro\n${code}${calls()}After`
    const stream = new RuntimeTextStream()
    const emitted = [...source].map((char) => stream.push(char)).join('')
    expect(emitted).toBe(`Intro\n${code}After`)
    expect(stream.finish().diagnostics).toHaveLength(1)
  })

  it('flushes ordinary unfinished HTML prefixes but never flushes recognized truncated protocol', () => {
    const stream = new RuntimeTextStream()
    expect(stream.push('a <')).toBe('a ')
    expect(stream.finish()).toEqual({ text: 'a <', diagnostics: [] })
    const other = new RuntimeTextStream()
    expect(other.push('a <｜｜DSML｜｜calls>secret')).toBe('a ')
    expect(other.finish()).toMatchObject({ text: 'a ', diagnostics: [{ code: 'truncated_tool_markup' }] })
  })

  it('keeps normal HTML and comparison text unchanged', () => {
    const source = '<div>Hello</div> a < b; 1 < 2 and `x < y`'
    const stream = new RuntimeTextStream()
    const emitted = [...source].map((char) => stream.push(char)).join('')
    expect(emitted).toBe(source)
    expect(stream.finish()).toEqual({ text: source, diagnostics: [] })
  })

  it('makes finish idempotent and rejects more text after finalization', () => {
    const stream = new RuntimeTextStream()
    stream.push(calls())
    expect(stream.finish()).toEqual(stream.finish())
    expect(() => stream.push('late')).toThrow('already finished')
  })
})
