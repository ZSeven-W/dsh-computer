import assert from 'node:assert/strict'
import test from 'node:test'
import { createComputerTools } from '../lib/index.js'

function driver() {
  return {
    kind: 'computer', platform: 'macos', contractVersion: 1,
    async observe() { throw new Error('not reached') },
    async act() { throw new Error('not reached') },
    async evidence() { throw new Error('not reached') },
    async disposeScope() {}, async dispose() {},
  }
}

test('raw structural tools expose full object-root parameter schemas', () => {
  const tools = createComputerTools(driver())
  for (const tool of Object.values(tools)) {
    assert.equal(tool.parameters.type, 'object')
    assert.equal(tool.parameters.additionalProperties, false)
    assert.equal(typeof tool.parameters.properties, 'object')
    assert.ok(Array.isArray(tool.parameters.required))
  }
  assert.deepEqual(tools.computerAct.parameters.required, ['action', 'ref'])
})

test('model tools reject missing Agent identity instead of sharing an agentless scope', async () => {
  const tools = createComputerTools(driver())
  await assert.rejects(
    tools.computerEvidence.execute({}, { rootCallId: 'call-1', signal: new AbortController().signal }),
    /requires a live Agent identity/,
  )
})
