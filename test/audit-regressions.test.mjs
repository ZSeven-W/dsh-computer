// Regression tests retargeted from the independent adversarial audit probes
// (/tmp/computer-audit1-work/probes) against this repository's built output.
// Each scenario guards one confirmed defect; the scenarios were added
// item-by-item alongside their fixes.
import assert from 'node:assert/strict'
import test from 'node:test'
import { ComputerController } from '../lib/index.js'

const app = {
  bundleId: 'dev.audit.fixture',
  pid: 4242,
  launchIdentity: 'audit-launch:/Fixture.app/Contents/MacOS/Fixture',
  name: 'Audit Fixture',
}
const window = {
  number: 17,
  role: 'AXWindow',
  subrole: 'AXStandardWindow',
  title: 'Audit Fixture Window',
  frame: { x: 10, y: 20, width: 900, height: 700 },
  identity: 'audit-window-digest',
}

export function node(index, overrides = {}) {
  return {
    role: 'AXButton',
    subrole: null,
    name: `Audit button ${index}`,
    identifier: `audit-button-${index}`,
    frame: { x: 30 + (index % 10) * 50, y: 40 + Math.floor(index / 10) * 20, width: 40, height:16 },
    enabled: true,
    focused: false,
    secure: false,
    actions: ['AXPress'],
    value: null,
    locator: [index],
    depth: 1,
    ...overrides,
  }
}

export function observation(nodes = [node(0)], overrides = {}) {
  return {
    capturedAt: '2026-09-03T00:00:00.000Z',
    app,
    window,
    nodes,
    truncated: false,
    ...overrides,
  }
}

function ids() {
  let value = 0
  return () => `audit-id-${++value}`
}

function basicNative(nodes = [node(0)], onRequest) {
  const native = {
    requests: [],
    disposedScopes: [],
    async request(request, options) {
      native.requests.push({ request: structuredClone(request), scopeId: options.scopeId })
      await onRequest?.(request, options)
      if (request.command === 'observe') return structuredClone(observation(nodes))
      if (request.command === 'status') return {
        platform: 'macos', accessibilityTrusted: true, screenRecordingTrusted: true,
        sessionLocked: false, interactiveSessionAvailable: true, helperVersion: 'fixture',
        helperExecutable: '/tmp/audit/helper', bundle: { path: null, identifier: null, version: null },
        signing: {
          signed: false, kind: 'unsigned', codeIdentifier: null, teamIdentifier: null,
          authorities: [], cdhash: null, statusCode: 0, detail: null,
        },
        process: { pid: 9001, ppid: 9000 },
        caller: { pid: 9000, executable: '/usr/bin/node', bundleIdentifier: null, name: 'node' },
        resolution: { source: 'explicit-override', selectedPath: '/tmp/audit/helper' },
        identityStable: false,
      }
      return { status: 'unknown', reason: 'audit fixture dispatched', accepted: true, post: null }
    },
    active: () => 0,
    async disposeScope(scope) { native.disposedScopes.push(scope) },
    async dispose() {},
  }
  return native
}

test('post-approval time past the credited deadline rejects before native dispatch (audit D1)', async () => {
  let now = 1_000
  let observeCount = 0
  const native = basicNative([node(0, { name: 'Submit order', identifier: 'submit' })], async request => {
    if (request.command === 'observe') {
      observeCount += 1
      // The third observe is the final preflight. Simulate a long lock/preflight
      // delay after approval that is NOT part of the human wait credit.
      if (observeCount === 3) now = 2_501
    }
  })
  const controller = new ComputerController({ native, now: () => now, id: ids(), platform: 'darwin' })
  const seen = await controller.observe({ ttlMs: 1_000 }, { scopeId: 'agent-a' })
  const receipt = await controller.act(
    { kind: 'click', ref: seen.targets[0].ref },
    { scopeId: 'agent-a', approval: { async request() { now = 1_100; return 'allowed-once' } } },
  )
  // Timeline: observed at 1,000, expires at 2,000, approval returned at 1,100
  // (credit 100ms => deadline 2,100), final preflight finished at 2,501.
  assert.equal(receipt.status, 'rejected')
  assert.match(receipt.reason, /approved action was not dispatched/u)
  assert.match(receipt.reason, /expired before action dispatch/u)
  assert.equal(receipt.nativeAccepted, false)
  assert.equal(native.requests.filter(entry => entry.request.command === 'act').length, 0, 'native act must never be dispatched')
})

test('a TTL-valid ref evicted by tombstone overflow still reports OBSERVATION_EVICTED (audit A1)', async () => {
  const nodes = Array.from({ length: 500 }, (_, index) => node(index))
  const native = basicNative(nodes)
  const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
  const first = await controller.observe({ ttlMs: 30_000, maxNodes: 500 }, { scopeId: 'agent-a' })
  // 600 observations of 500 nodes each: the old per-ref FIFO (16,384 refs)
  // aged out the first observation's tombstones after 33 count evictions of
  // 500 refs and reported a false unknown reference.
  for (let index = 0; index < 599; index += 1) {
    await controller.observe({ ttlMs: 30_000, maxNodes: 500 }, { scopeId: 'agent-a' })
  }
  const receipt = await controller.act({ kind: 'click', ref: first.targets[0].ref }, { scopeId: 'agent-a' })
  assert.equal(receipt.status, 'rejected')
  assert.match(receipt.reason, /OBSERVATION_EVICTED/)
  assert.doesNotMatch(receipt.reason, /unknown reference/)
  assert.equal(native.requests.filter(entry => entry.request.command === 'act').length, 0)
})

test('aggregate observation payload is byte-budgeted and evicts oldest TTL-valid first (audit A2)', async () => {
  // ~2 MiB of serialized payload per observation: without a byte budget the
  // probe retained 512 x 500-node observations (~220 MiB of heap). With a
  // 32 MiB per-scope budget the oldest observations must be evicted (and
  // recorded as OBSERVATION_EVICTED) while the most recent one survives.
  const heavyNode = node(0, { name: 'Heavy', value: 'x'.repeat(2 * 1024 * 1024) })
  const native = basicNative([heavyNode])
  const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
  const first = await controller.observe({ ttlMs: 30_000 }, { scopeId: 'agent-a' })
  const firstRef = first.targets[0].ref
  let latest = null
  for (let index = 0; index < 30; index += 1) {
    latest = await controller.observe({ ttlMs: 30_000 }, { scopeId: 'agent-a' })
  }
  const evidence = await controller.evidence({ scopeId: 'agent-a' }, { limit: 1 })
  assert.ok(evidence.activeObservations >= 1, 'the most recent observation is never evicted')
  assert.ok(evidence.activeObservations < 31, 'aggregate payload must be bounded below the retained count')
  const evicted = await controller.act({ kind: 'click', ref: firstRef }, { scopeId: 'agent-a' })
  assert.equal(evicted.status, 'rejected')
  assert.match(evicted.reason, /OBSERVATION_EVICTED/, 'byte-budget eviction must still be reported honestly')
  const recent = await controller.act({ kind: 'focus', ref: latest.targets[0].ref }, { scopeId: 'agent-a' })
  assert.equal(recent.status, 'unknown', 'the newest observation stays live and dispatchable')
  assert.equal(recent.nativeAccepted, true)
})
