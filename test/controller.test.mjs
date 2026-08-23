import assert from 'node:assert/strict'
import test from 'node:test'
import { ComputerController, NativeHelperError } from '../lib/index.js'
import { FakeNative, node, observation } from './fixtures.mjs'

function ids() {
  let value = 0
  return () => `id-${++value}`
}

test('observation returns opaque refs and never exposes native locator', async () => {
  const native = new FakeNative()
  const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
  const result = await controller.observe({ ttlMs: 5_000 }, { scopeId: 'agent-a' })

  assert.match(result.observationId, /^obs_id-/)
  assert.match(result.fingerprint, /^[a-f0-9]{64}$/)
  assert.equal(result.expiresAt, new Date(6_000).toISOString())
  assert.match(result.targets[0].ref, /^cu_[A-Za-z0-9_-]+$/)
  assert.equal('locator' in result.targets[0], false)
  assert.deepEqual(native.requests[0].request.maxDepth, 4)
  assert.deepEqual(native.requests[0].request.maxNodes, 200)
})

test('opaque refs are isolated by host-derived Agent scope', async () => {
  const native = new FakeNative()
  const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
  const seen = await controller.observe({}, { scopeId: 'agent-a' })
  const receipt = await controller.act({ kind: 'click', ref: seen.targets[0].ref }, { scopeId: 'agent-b' })

  assert.equal(receipt.status, 'rejected')
  assert.match(receipt.reason, /unknown reference in this Agent scope/)
  assert.equal(native.requests.filter(entry => entry.request.command === 'act').length, 0)
})

test('expired observations reject before native action preflight', async () => {
  let now = 1_000
  const native = new FakeNative()
  const controller = new ComputerController({ native, now: () => now, id: ids(), platform: 'darwin' })
  const seen = await controller.observe({ ttlMs: 1_000 }, { scopeId: 'agent-a' })
  now = 2_001
  const receipt = await controller.act({ kind: 'click', ref: seen.targets[0].ref }, { scopeId: 'agent-a' })

  assert.equal(receipt.status, 'rejected')
  assert.match(receipt.reason, /stale observation/)
  assert.equal(native.requests.filter(entry => entry.request.command === 'act').length, 0)
})

test('secure text and deterministic high-risk semantics do not rely on a caller flag', async t => {
  await t.test('secure field', async () => {
    const native = new FakeNative({ observation: observation({ nodes: [node({ role: 'AXTextField', secure: true })] }) })
    const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
    const seen = await controller.observe({}, { scopeId: 'agent-a' })
    const receipt = await controller.act({ kind: 'type', ref: seen.targets[0].ref, text: 'secret' }, { scopeId: 'agent-a' })
    assert.equal(receipt.status, 'rejected')
    assert.match(receipt.reason, /secure text/)
  })

  await t.test('destructive button', async () => {
    const native = new FakeNative({ observation: observation({ nodes: [node({ name: 'Delete account' })] }) })
    const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
    const seen = await controller.observe({}, { scopeId: 'agent-a' })
    const receipt = await controller.act({ kind: 'click', ref: seen.targets[0].ref }, { scopeId: 'agent-a' })
    assert.equal(receipt.status, 'rejected')
    assert.match(receipt.reason, /high-risk target semantics/)
  })
})

test('native receives the full observed identity and its post-action evidence is preserved', async () => {
  const native = new FakeNative()
  const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
  const seen = await controller.observe({}, { scopeId: 'agent-a' })
  const receipt = await controller.act({ kind: 'click', ref: seen.targets[0].ref }, { scopeId: 'agent-a' })
  const request = native.requests.find(entry => entry.request.command === 'act').request

  assert.deepEqual(request.expected.app, observation().app)
  assert.deepEqual(request.expected.window, observation().window)
  assert.deepEqual(request.expected.locator, [0, 1])
  assert.equal(request.expected.element.identifier, 'open-settings')
  assert.equal(receipt.status, 'unknown')
  assert.equal(receipt.nativeAccepted, true)
  assert.equal(receipt.postAction.target.identifier, 'open-settings')
  const second = await controller.act({ kind: 'click', ref: seen.targets[0].ref }, { scopeId: 'agent-a' })
  assert.equal(second.status, 'rejected')
  assert.match(second.reason, /unknown reference/)
})

test('type then Return cannot bypass risk policy and mutation refs are single-use', async () => {
  const textField = node({
    role: 'AXTextField', name: 'Message', identifier: 'message', actions: [], value: '', focused: true,
  })
  const native = new FakeNative({
    observation: observation({ nodes: [textField] }),
    actionResult: {
      status: 'confirmed', reason: 'typed value was re-observed', accepted: true,
      post: {
        capturedAt: '2026-08-24T00:00:00.100Z', app: observation().app, window: observation().window,
        target: { ...textField, value: 'publish this', locator: undefined, depth: undefined },
      },
    },
  })
  const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
  const first = await controller.observe({}, { scopeId: 'agent-a' })
  const typed = await controller.act(
    { kind: 'type', ref: first.targets[0].ref, text: 'publish this' }, { scopeId: 'agent-a' },
  )
  assert.equal(typed.status, 'confirmed')

  const reused = await controller.act(
    { kind: 'key', ref: first.targets[0].ref, key: 'Return' }, { scopeId: 'agent-a' },
  )
  assert.equal(reused.status, 'rejected')
  assert.match(reused.reason, /unknown reference/)

  const fresh = await controller.observe({}, { scopeId: 'agent-a' })
  const commit = await controller.act(
    { kind: 'key', ref: fresh.targets[0].ref, key: 'Return' }, { scopeId: 'agent-a' },
  )
  assert.equal(commit.status, 'rejected')
  assert.match(commit.reason, /commit key is blocked/)
  assert.equal(native.requests.filter(entry => entry.request.command === 'act').length, 1)
})

test('key actions use an explicit navigation allowlist and block control-j/control-m', async () => {
  for (const key of ['j', 'm']) {
    const native = new FakeNative()
    const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
    const seen = await controller.observe({}, { scopeId: 'agent-a' })
    const receipt = await controller.act(
      { kind: 'key', ref: seen.targets[0].ref, key, modifiers: ['control'] }, { scopeId: 'agent-a' },
    )
    assert.equal(receipt.status, 'rejected')
    assert.match(receipt.reason, /explicit safe navigation allowlist/)
    assert.equal(native.requests.filter(entry => entry.request.command === 'act').length, 0)
  }

  const native = new FakeNative()
  const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
  const seen = await controller.observe({}, { scopeId: 'agent-a' })
  const safe = await controller.act(
    { kind: 'key', ref: seen.targets[0].ref, key: 'left', modifiers: ['option'] }, { scopeId: 'agent-a' },
  )
  assert.equal(safe.status, 'unknown')
  assert.equal(native.requests.filter(entry => entry.request.command === 'act').length, 1)
})

test('transport loss after dispatch produces unknown, never a false failed claim', async () => {
  const native = new FakeNative({
    actionError: new NativeHelperError('helper_transport_lost', 'connection closed', true),
  })
  const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
  const seen = await controller.observe({}, { scopeId: 'agent-a' })
  const receipt = await controller.act({ kind: 'click', ref: seen.targets[0].ref }, { scopeId: 'agent-a' })

  assert.equal(receipt.status, 'unknown')
  assert.match(receipt.reason, /outcome is unknown after transport loss/)
})

test('a native confirmed click with missing or rebound post-state is downgraded to unknown', async () => {
  const native = new FakeNative({
    actionResult: { status: 'confirmed', reason: 'incorrect native claim', accepted: true, post: null },
  })
  const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
  const seen = await controller.observe({}, { scopeId: 'agent-a' })
  const receipt = await controller.act({ kind: 'click', ref: seen.targets[0].ref }, { scopeId: 'agent-a' })
  assert.equal(receipt.status, 'unknown')
  assert.match(receipt.reason, /confirmation was downgraded/)
})

test('proved pre-dispatch helper failure remains failed', async () => {
  const native = new FakeNative({
    actionError: new NativeHelperError('helper_unavailable', 'binary missing', false),
  })
  const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
  const seen = await controller.observe({}, { scopeId: 'agent-a' })
  const receipt = await controller.act({ kind: 'click', ref: seen.targets[0].ref }, { scopeId: 'agent-a' })
  assert.equal(receipt.status, 'failed')
})

test('disposeScope clears evidence and delegates native cancellation/cleanup', async () => {
  const native = new FakeNative()
  const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
  await controller.observe({}, { scopeId: 'agent-a' })
  await controller.disposeScope('agent-a')
  const evidence = await controller.evidence({ scopeId: 'agent-a' })

  assert.deepEqual(native.disposedScopes, ['agent-a'])
  assert.equal(evidence.activeObservations, 0)
})

test('an in-flight observation cannot recreate state after Agent scope disposal', async () => {
  let release
  const native = new FakeNative()
  native.request = async request => {
    if (request.command !== 'observe') return { platform: 'macos', accessibilityTrusted: true, helperVersion: 'fixture' }
    return new Promise(resolve => { release = () => resolve(observation()) })
  }
  const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
  const pending = controller.observe({}, { scopeId: 'agent-a' })
  await new Promise(resolve => setImmediate(resolve))
  await controller.disposeScope('agent-a')
  release()
  await assert.rejects(pending, /scope was disposed/)
  const evidence = await controller.evidence({ scopeId: 'agent-a' })
  assert.equal(evidence.activeObservations, 0)
})
