import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, COMPUTER_DRIVER_SERVICE, COMPUTER_TOOL_NAMES, inject } from '../lib/index.js'

test('plugin provides driver v5, registers five tools, and unprovides before driver disposal', async () => {
  const events = []
  const registered = []
  let provided
  let agentDisposed
  let approvalLookups = 0
  const ctx = {
    tools: {
      register(tool) {
        registered.push(tool.name)
        return () => events.push(`unregister:${tool.name}`)
      },
    },
    get(name) {
      assert.equal(name, 'approval')
      approvalLookups += 1
      return undefined
    },
    effect(factory) { return factory() },
    on(event, listener) {
      assert.equal(event, 'agent/disposed')
      agentDisposed = listener
      return () => events.push('off:agent/disposed')
    },
    provide(name, value) {
      provided = value
      events.push(`provide:${name}`)
      const originalDispose = value.dispose.bind(value)
      value.dispose = async () => { events.push('driver:dispose'); await originalDispose() }
      return () => events.push(`unprovide:${name}`)
    },
    logger: { info() {} },
  }

  const dispose = apply(ctx)
  assert.deepEqual(inject, ['tools'], 'optional approval must not be a hard Cordis injection')
  assert.equal(approvalLookups, 0, 'approval service is resolved only inside a risky computer_act execution')
  assert.deepEqual(registered, [...COMPUTER_TOOL_NAMES])
  assert.equal(provided.kind, 'computer')
  assert.equal(provided.contractVersion, 5)
  assert.equal(typeof provided.visualObserve, 'function')
  let disposedScope
  provided.disposeScope = async scope => { disposedScope = scope }
  await agentDisposed({ agent: { id: 'agent-a' } })
  assert.equal(disposedScope, 'agent-a')
  await dispose()

  assert.ok(events.indexOf(`unprovide:${COMPUTER_DRIVER_SERVICE}`) < events.indexOf('driver:dispose'))
  assert.deepEqual(events.filter(event => event.startsWith('unregister:')), [
    'unregister:computer_evidence', 'unregister:computer_act',
    'unregister:computer_visual_act', 'unregister:computer_visual_observe', 'unregister:computer_observe',
    'unregister:computer_launch', 'unregister:computer_apps',
  ])
})
