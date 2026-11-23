const readline = require('node:readline')
const assert = require('node:assert/strict')
const args = process.argv.slice(2)
if (args.includes('--version')) {
  process.stdout.write('DSH runtime fixture\n')
  process.exit(0)
}
assert.deepEqual(args, ['--profile', 'sdk'])
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
let sessionId, text, resumed
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { method, id, params } = JSON.parse(line)
  const reply = (result = {}) => send({ id, result })
  if (method === 'initialize') {
    assert.equal(params.provider, 'fixture-provider')
    assert.equal(params.model, 'fixture-model')
    return reply({ serverInfo: { name: 'deepseek-harness-sdk-runtime' } })
  }
  if (method === 'session/resume') {
    resumed = params.sessionId
    return reply()
  }
  if (method === 'session/prompt') {
    sessionId = params.sessionId
    text = params.contentBlocks[0].text
    assert.ok(!resumed || sessionId === resumed)
    return reply({ messageId: 'queued' })
  }
  if (method === 'session/wait') {
    assert.equal(params.sessionId, sessionId)
    const event = (seq, type, data) => send({ method: 'session.event', params: { sessionId, event: { seq, type, data } } })
    event(1, 'assistant/message', { message: { content: [{ type: 'text', text: `DSH ${resumed ? 'resumed' : 'new'} ${text.split('\n').at(-1)}` }] } })
    event(2, 'turn/end', { reason: { kind: 'completed' } })
    return reply()
  }
  throw new Error(`Unexpected DSH request ${method}`)
})
