import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, COMPUTER_DRIVER_SERVICE, COMPUTER_TOOL_NAMES } from '../lib/index.js'

test('plugin provides driver, registers three tools, and unprovides before driver disposal', async () => {
  const events = []
  const registered = []
  let provided
  let agentDisposed
  const ctx = {
    tools: {
      register(tool) {
        registered.push(tool.name)
        return () => events.push(`unregister:${tool.name}`)
      },
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
  assert.deepEqual(registered, [...COMPUTER_TOOL_NAMES])
  assert.equal(provided.kind, 'computer')
  let disposedScope
  provided.disposeScope = async scope => { disposedScope = scope }
  await agentDisposed({ agent: { id: 'agent-a' } })
  assert.equal(disposedScope, 'agent-a')
  await dispose()

  assert.ok(events.indexOf(`unprovide:${COMPUTER_DRIVER_SERVICE}`) < events.indexOf('driver:dispose'))
  assert.deepEqual(events.filter(event => event.startsWith('unregister:')), [
    'unregister:computer_evidence', 'unregister:computer_act', 'unregister:computer_observe',
  ])
})
