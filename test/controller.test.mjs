import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { ComputerController, NativeHelperError } from '../lib/index.js'
import { FakeNative, nativeStatus, node, observation } from './fixtures.mjs'

function ids() {
  let value = 0
  return () => `id-${++value}`
}

function captureFixture(onCapture) {
  return async (_native, request, options) => {
    await onCapture?.(request, options)
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
    return {
      png,
      result: {
        capturedAt: '2026-08-24T00:00:00.050Z',
        app: structuredClone(request.capture.app),
        window: structuredClone(request.capture.window),
        artifact: { format: 'png', byteLength: png.length, sha256: 'a'.repeat(64) },
        pointFrame: structuredClone(request.capture.window.frame),
        pixelWidth: 1800,
        pixelHeight: 1400,
        scaleX: 2,
        scaleY: 2,
        quality: {
          classification: 'usable', usable: true, sampleCount: 100, visibleFraction: 1,
          meanLuminance: 0.5, luminanceVariance: 0.1, luminanceRange: 0.8,
          darkFraction: 0.1, lightFraction: 0.1, distinctColorBuckets: 16,
        },
        marks: request.capture.targets.map((target, index) => ({
          number: index + 1,
          ref: target.ref,
          index: target.index,
          pixelFrame: { x: 20 + index * 100, y: 30, width: 80, height: 40 },
        })),
        omitted: [],
      },
    }
  }
}

function concurrencyNative(observationForScope, onRequest) {
  const native = {
    requests: [],
    disposedScopes: [],
    disposed: false,
    async request(request, options) {
      native.requests.push({ request: structuredClone(request), scopeId: options.scopeId })
      await onRequest?.(request, options)
      if (request.command === 'observe') return structuredClone(observationForScope(options.scopeId))
      if (request.command === 'status') return nativeStatus()
      return { status: 'unknown', reason: 'fixture action dispatched', accepted: true, post: null }
    },
    active() { return 0 },
    async disposeScope(scope) { native.disposedScopes.push(scope) },
    async dispose() { native.disposed = true },
  }
  return native
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

test('observe snapshots nested input before await and public mutations cannot corrupt internal capabilities or evidence', async () => {
  let releaseObserve
  let capturedRequest
  const firstNativeResult = structuredClone(observation())
  const native = new FakeNative({ observation: firstNativeResult })
  const baseRequest = native.request.bind(native)
  let delayFirst = true
  native.request = async (request, options) => {
    if (delayFirst && request.command === 'observe') {
      delayFirst = false
      capturedRequest = request
      await new Promise(resolve => { releaseObserve = resolve })
    }
    return baseRequest(request, options)
  }
  const captures = []
  const controller = new ComputerController({
    native,
    capture: captureFixture(request => { captures.push(structuredClone(request)) }),
    now: () => 1_000,
    id: ids(),
    platform: 'darwin',
  })
  const input = {
    app: { bundleId: 'dev.zseven.fixture', pid: 4242 },
    window: { number: 17, title: 'Fixture Window' },
    maxDepth: 4,
    maxNodes: 200,
  }
  const pending = controller.observe(input, { scopeId: 'agent-a' })
  input.app.bundleId = 'attacker.changed.app'
  input.window.number = 999
  releaseObserve()
  const seen = await pending
  assert.equal(capturedRequest.app.bundleId, 'dev.zseven.fixture')
  assert.equal(capturedRequest.window.number, 17)

  const originalRef = seen.targets[0].ref
  firstNativeResult.app.bundleId = 'transport.alias.changed'
  firstNativeResult.window.title = 'Transport alias changed'
  firstNativeResult.nodes[0].actions.push('InjectedAction')
  native.options.observation = structuredClone(observation())
  seen.app.bundleId = 'public.changed.app'
  seen.window.title = 'Public changed window'
  seen.window.frame.x = 999
  seen.targets[0].name = 'Public changed target'
  seen.targets[0].frame.x = 888
  seen.targets[0].actions.push('InjectedAction')

  await controller.visualObserve({ observationId: seen.observationId }, { scopeId: 'agent-a' })
  assert.equal(captures[0].capture.app.bundleId, 'dev.zseven.fixture')
  assert.equal(captures[0].capture.window.title, 'Fixture Window')
  assert.equal(captures[0].capture.window.frame.x, 10)
  assert.equal(captures[0].capture.targets[0].element.name, 'Open settings')
  assert.deepEqual(captures[0].capture.targets[0].element.actions, ['AXPress'])

  const receipt = await controller.act({ kind: 'focus', ref: originalRef }, { scopeId: 'agent-a' })
  const nativeAct = native.requests.find(entry => entry.request.command === 'act').request
  assert.equal(nativeAct.expected.app.bundleId, 'dev.zseven.fixture')
  assert.equal(nativeAct.expected.window.title, 'Fixture Window')
  assert.equal(nativeAct.expected.window.frame.x, 10)
  assert.equal(nativeAct.expected.element.name, 'Open settings')
  assert.deepEqual(nativeAct.expected.element.actions, ['AXPress'])

  const storedReason = receipt.reason
  receipt.reason = 'public receipt mutation'
  receipt.postAction.app.bundleId = 'public.receipt.changed'
  receipt.postAction.window.title = 'public receipt window changed'
  receipt.postAction.target.actions.push('InjectedAction')
  const evidence = await controller.evidence({ scopeId: 'agent-a' })
  assert.equal(evidence.receipts[0].reason, storedReason)
  assert.equal(evidence.receipts[0].postAction.app.bundleId, 'dev.zseven.fixture')
  assert.equal(evidence.receipts[0].postAction.window.title, 'Fixture Window')
  assert.deepEqual(evidence.receipts[0].postAction.target.actions, ['AXPress'])
})

test('visual observation binds the exact scoped observation, prioritizes interactive framed nodes, and preserves refs', async () => {
  const nodes = [
    node({ role: 'AXStaticText', name: 'Heading', actions: [], identifier: 'heading', locator: [0], depth: 1 }),
    node({ role: 'AXButton', name: 'Primary', identifier: 'primary', locator: [1], depth: 1 }),
    node({ role: 'AXButton', name: 'No frame', identifier: 'no-frame', frame: null, locator: [2], depth: 1 }),
    node({
      role: 'AXWindow', name: 'Fixture Window', identifier: null, actions: ['AXRaise'],
      frame: observation().window.frame, locator: [3], depth: 0,
    }),
  ]
  const native = new FakeNative({ observation: observation({ nodes }) })
  const captures = []
  const controller = new ComputerController({
    native,
    capture: captureFixture(request => { captures.push(request) }),
    now: () => 1_000,
    id: ids(),
    platform: 'darwin',
  })
  const seen = await controller.observe({ ttlMs: 5_000 }, { scopeId: 'agent-a' })
  const first = await controller.visualObserve(
    { observationId: seen.observationId, maxMarks: 1 }, { scopeId: 'agent-a' },
  )

  assert.equal(captures[0].capture.window.number, 17)
  assert.equal(captures[0].capture.targets.length, 1)
  assert.equal(captures[0].capture.targets[0].index, 1, 'interactive framed node wins over earlier static text')
  assert.equal(captures[0].capture.targets[0].ref, seen.targets[1].ref)
  assert.deepEqual(first.marks[0], {
    number: 1,
    ref: seen.targets[1].ref,
    sourceIndex: 1,
    nativePixelFrame: { x: 20, y: 30, width: 80, height: 40 },
  })
  assert.equal('locator' in first.marks[0], false)

  const second = await controller.visualObserve({ observationId: seen.observationId }, { scopeId: 'agent-a' })
  assert.equal(second.observationId, seen.observationId, 'visual reads do not consume the observation')
  assert.equal(captures[1].capture.targets.some(target => target.index === 0), false, 'static labels are not numbered')
  assert.equal(captures[1].capture.targets.some(target => target.index === 2), false, 'unframed nodes are never marked')
  assert.equal(captures[1].capture.targets.some(target => target.index === 3), false, 'window containers are not numbered')
})

test('visual Set-of-Mark budget defaults to 80 and is capped at 200', async () => {
  const nodes = Array.from({ length: 205 }, (_, index) => node({
    name: `Button ${index}`,
    identifier: `button-${index}`,
    locator: [index],
    frame: { x: 20 + (index % 10) * 50, y: 30 + Math.floor(index / 10) * 20, width: 40, height: 16 },
  }))
  const requests = []
  const controller = new ComputerController({
    native: new FakeNative({ observation: observation({ nodes }) }),
    capture: captureFixture(request => { requests.push(request) }),
    now: () => 1_000,
    id: ids(),
    platform: 'darwin',
  })
  const seen = await controller.observe({}, { scopeId: 'agent-a' })
  await controller.visualObserve({ observationId: seen.observationId }, { scopeId: 'agent-a' })
  await controller.visualObserve(
    { observationId: seen.observationId, maxMarks: 999 }, { scopeId: 'agent-a' },
  )
  assert.equal(requests[0].capture.targets.length, 80)
  assert.equal(requests[1].capture.targets.length, 200)
})

test('visual observation rejects cross-Agent and expired observation ids before capture', async () => {
  let now = 1_000
  let captures = 0
  const native = new FakeNative()
  const controller = new ComputerController({
    native,
    capture: captureFixture(() => { captures += 1 }),
    now: () => now,
    id: ids(),
    platform: 'darwin',
  })
  const seen = await controller.observe({ ttlMs: 1_000 }, { scopeId: 'agent-a' })
  await assert.rejects(
    controller.visualObserve({ observationId: seen.observationId }, { scopeId: 'agent-b' }),
    /Agent scope/u,
  )
  now = 2_001
  await assert.rejects(
    controller.visualObserve({ observationId: seen.observationId }, { scopeId: 'agent-a' }),
    /expired|stale/u,
  )
  assert.equal(captures, 0)
})

test('visual capture shares the observation mutex with act and revalidates TTL after capture', async () => {
  let now = 1_000
  let release
  let started
  const startedPromise = new Promise(resolve => { started = resolve })
  const native = new FakeNative()
  const controller = new ComputerController({
    native,
    capture: captureFixture(async () => {
      started()
      await new Promise(resolve => { release = resolve })
    }),
    now: () => now,
    id: ids(),
    platform: 'darwin',
  })
  const seen = await controller.observe({ ttlMs: 1_000 }, { scopeId: 'agent-a' })
  const pending = controller.visualObserve({ observationId: seen.observationId }, { scopeId: 'agent-a' })
  await startedPromise
  const action = await controller.act({ kind: 'focus', ref: seen.targets[0].ref }, { scopeId: 'agent-a' })
  assert.equal(action.status, 'rejected')
  assert.match(action.reason, /another operation/u)
  now = 2_001
  release()
  await assert.rejects(pending, /expired while computer_visual_observe/u)
  assert.equal(native.requests.filter(entry => entry.request.command === 'act').length, 0)
})

test('scope disposal fences an in-flight visual capture and visual requirements do not affect AX observation', async () => {
  let release
  let started
  const startedPromise = new Promise(resolve => { started = resolve })
  const native = new FakeNative({ observation: observation({ window: { ...observation().window, number: null } }) })
  const controller = new ComputerController({
    native,
    capture: captureFixture(async () => {
      started()
      await new Promise(resolve => { release = resolve })
    }),
    now: () => 1_000,
    id: ids(),
    platform: 'darwin',
  })
  const noNumber = await controller.observe({}, { scopeId: 'agent-a' })
  assert.equal(noNumber.window.number, null, 'computer_observe remains usable without a capturable window number')
  await assert.rejects(
    controller.visualObserve({ observationId: noNumber.observationId }, { scopeId: 'agent-a' }),
    /exact window number and frame/u,
  )

  native.options.observation = observation()
  const capturable = await controller.observe({}, { scopeId: 'agent-a' })
  const pending = controller.visualObserve({ observationId: capturable.observationId }, { scopeId: 'agent-a' })
  await startedPromise
  await controller.disposeScope('agent-a')
  release()
  await assert.rejects(pending, /scope was disposed/u)
})

test('same app launch serializes different scopes and windows through final preflight and act', async () => {
  const sameApp = structuredClone(observation().app)
  const observations = {
    'agent-a': observation({ app: sameApp, window: { ...observation().window, number: 17, identity: 'window-a' } }),
    'agent-b': observation({ app: sameApp, window: { ...observation().window, number: 18, title: 'Other', identity: 'window-b' } }),
  }
  let tracking = false
  const events = []
  let releaseA
  let startedA
  const startedAPromise = new Promise(resolve => { startedA = resolve })
  const native = concurrencyNative(scope => observations[scope], async (request, options) => {
    if (!tracking) return
    events.push(`${request.command}:${options.scopeId}`)
    if (request.command === 'act' && options.scopeId === 'agent-a') {
      startedA()
      await new Promise(resolve => { releaseA = resolve })
    }
  })
  const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
  const seenA = await controller.observe({}, { scopeId: 'agent-a' })
  const seenB = await controller.observe({}, { scopeId: 'agent-b' })
  tracking = true
  const pendingA = controller.act({ kind: 'focus', ref: seenA.targets[0].ref }, { scopeId: 'agent-a' })
  await startedAPromise
  const pendingB = controller.act({ kind: 'focus', ref: seenB.targets[0].ref }, { scopeId: 'agent-b' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(events.some(event => event.endsWith(':agent-b')), false, 'second scope must wait before native preflight')
  releaseA()
  await Promise.all([pendingA, pendingB])
  assert.deepEqual(events, ['observe:agent-a', 'act:agent-a', 'observe:agent-b', 'act:agent-b'])
})

test('different app launches can preflight and act concurrently', async () => {
  const observationA = structuredClone(observation())
  const observationB = observation({
    app: {
      bundleId: 'dev.zseven.other', pid: 5252,
      launchIdentity: '1787500000000001:/Other.app/Contents/MacOS/Other', name: 'Other',
    },
    window: { ...observation().window, number: 18, title: 'Other', identity: 'window-other' },
  })
  const observations = { 'agent-a': observationA, 'agent-b': observationB }
  let tracking = false
  let releaseA
  let startedA
  let startedB
  const startedAPromise = new Promise(resolve => { startedA = resolve })
  const startedBPromise = new Promise(resolve => { startedB = resolve })
  const native = concurrencyNative(scope => observations[scope], async (request, options) => {
    if (!tracking || request.command !== 'act') return
    if (options.scopeId === 'agent-a') {
      startedA()
      await new Promise(resolve => { releaseA = resolve })
    } else {
      startedB()
    }
  })
  const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
  const seenA = await controller.observe({}, { scopeId: 'agent-a' })
  const seenB = await controller.observe({}, { scopeId: 'agent-b' })
  tracking = true
  const pendingA = controller.act({ kind: 'focus', ref: seenA.targets[0].ref }, { scopeId: 'agent-a' })
  await startedAPromise
  const pendingB = controller.act({ kind: 'focus', ref: seenB.targets[0].ref }, { scopeId: 'agent-b' })
  await startedBPromise
  const resultB = await pendingB
  assert.notEqual(resultB.status, 'rejected')
  releaseA()
  await pendingA
})

test('visual capture holds the app lock for its full capture lifetime', async () => {
  const observations = {
    'agent-a': structuredClone(observation()),
    'agent-b': observation({ window: { ...observation().window, number: 18, title: 'Other', identity: 'window-b' } }),
  }
  let tracking = false
  const events = []
  const native = concurrencyNative(scope => observations[scope], async (request, options) => {
    if (tracking) events.push(`${request.command}:${options.scopeId}`)
  })
  let releaseCapture
  let captureStarted
  const captureStartedPromise = new Promise(resolve => { captureStarted = resolve })
  const controller = new ComputerController({
    native,
    capture: captureFixture(async () => {
      captureStarted()
      await new Promise(resolve => { releaseCapture = resolve })
    }),
    now: () => 1_000,
    id: ids(),
    platform: 'darwin',
  })
  const seenA = await controller.observe({}, { scopeId: 'agent-a' })
  const seenB = await controller.observe({}, { scopeId: 'agent-b' })
  tracking = true
  const pendingCapture = controller.visualObserve({ observationId: seenA.observationId }, { scopeId: 'agent-a' })
  await captureStartedPromise
  const pendingAct = controller.act({ kind: 'focus', ref: seenB.targets[0].ref }, { scopeId: 'agent-b' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events, [], 'act cannot begin final preflight while same-app capture holds lock')
  releaseCapture()
  await Promise.all([pendingCapture, pendingAct])
  assert.deepEqual(events, ['observe:agent-b', 'act:agent-b'])
})

test('abort and disposeScope cancel same-app lock waiters before native dispatch', async () => {
  const observations = {
    'agent-a': structuredClone(observation()),
    'agent-b': structuredClone(observation()),
    'agent-c': structuredClone(observation()),
  }
  let tracking = false
  let releaseA
  let startedA
  const startedAPromise = new Promise(resolve => { startedA = resolve })
  const native = concurrencyNative(scope => observations[scope], async (request, options) => {
    if (tracking && request.command === 'act' && options.scopeId === 'agent-a') {
      startedA()
      await new Promise(resolve => { releaseA = resolve })
    }
  })
  const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
  const seenA = await controller.observe({}, { scopeId: 'agent-a' })
  const seenB = await controller.observe({}, { scopeId: 'agent-b' })
  const seenC = await controller.observe({}, { scopeId: 'agent-c' })
  tracking = true
  const pendingA = controller.act({ kind: 'focus', ref: seenA.targets[0].ref }, { scopeId: 'agent-a' })
  await startedAPromise

  const abort = new AbortController()
  const pendingB = controller.act(
    { kind: 'focus', ref: seenB.targets[0].ref }, { scopeId: 'agent-b', signal: abort.signal },
  )
  await new Promise(resolve => setImmediate(resolve))
  abort.abort()
  const resultB = await pendingB
  assert.equal(resultB.status, 'rejected')
  assert.match(resultB.reason, /cancelled before dispatch/u)

  const pendingC = controller.act({ kind: 'focus', ref: seenC.targets[0].ref }, { scopeId: 'agent-c' })
  await new Promise(resolve => setImmediate(resolve))
  await controller.disposeScope('agent-c')
  const resultC = await pendingC
  assert.equal(resultC.status, 'rejected')
  assert.match(resultC.reason, /scope was disposed.*window lock/u)
  assert.equal(native.requests.some(entry => entry.scopeId === 'agent-b' && entry.request.command === 'act'), false)
  assert.equal(native.requests.some(entry => entry.scopeId === 'agent-c' && entry.request.command === 'act'), false)
  releaseA()
  await pendingA
})

test('computer evidence losslessly exposes stable helper, TCC, signing, process, caller and resolution status', async () => {
  const status = nativeStatus({ screenRecordingTrusted: false, identityStable: false })
  const native = new FakeNative({ status })
  const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
  const evidence = await controller.evidence({ scopeId: 'agent-a' })

  assert.equal(evidence.contractVersion, 3)
  assert.deepEqual(evidence.status, {
    platform: 'macos', helper: 'ready',
    accessibilityTrusted: status.accessibilityTrusted,
    screenRecordingTrusted: status.screenRecordingTrusted,
    sessionLocked: status.sessionLocked,
    interactiveSessionAvailable: status.interactiveSessionAvailable,
    helperVersion: status.helperVersion,
    helperExecutable: status.helperExecutable,
    bundle: status.bundle,
    signing: status.signing,
    process: status.process,
    caller: status.caller,
    resolution: status.resolution,
    identityStable: status.identityStable,
    detail: 'native helper fixture; interactive session available; Accessibility trusted; Screen Recording not granted; identity development/unstable',
  })
  assert.doesNotThrow(() => JSON.stringify(evidence))
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
    let approvalCalls = 0
    const receipt = await controller.act(
      { kind: 'type', ref: seen.targets[0].ref, text: 'secret' },
      { scopeId: 'agent-a', approval: { async request() { approvalCalls += 1; return 'allowed-once' } } },
    )
    assert.equal(receipt.status, 'rejected')
    assert.match(receipt.reason, /secure text/)
    assert.equal(approvalCalls, 0)
    assert.equal(native.requests.length, 1, 'hard deny must not even enter native preflight')
  })

  await t.test('destructive button', async () => {
    const native = new FakeNative({ observation: observation({ nodes: [node({ name: 'Delete account' })] }) })
    const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
    const seen = await controller.observe({}, { scopeId: 'agent-a' })
    const receipt = await controller.act({ kind: 'click', ref: seen.targets[0].ref }, { scopeId: 'agent-a' })
    assert.equal(receipt.status, 'rejected')
    assert.match(receipt.reason, /host approval is unavailable/)
    assert.match(receipt.reason, /destructive operation/)
  })
})

test('approval-required action is live-preflighted, informed, granted once, revalidated, and privately stamped', async () => {
  const risky = node({
    name: 'Delete account\nsecondary', identifier: 'delete-account', value: 'SENSITIVE_VALUE_SHOULD_NOT_LEAK',
  })
  const native = new FakeNative({ observation: observation({ nodes: [risky] }) })
  const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
  const seen = await controller.observe({}, { scopeId: 'agent-a' })
  const reasons = []
  const callerAction = { kind: 'click', ref: seen.targets[0].ref, text: 'SENSITIVE_INPUT_SHOULD_NOT_LEAK' }
  const receipt = await controller.act(
    callerAction,
    {
      scopeId: 'agent-a',
      approval: {
        async request(reason) {
          reasons.push(reason)
          assert.equal(native.requests.filter(entry => entry.request.command === 'observe').length, 2)
          assert.equal(native.requests.filter(entry => entry.request.command === 'act').length, 0)
          return 'allowed-once'
        },
      },
    },
  )

  assert.equal(receipt.status, 'unknown')
  assert.equal(reasons.length, 1)
  assert.ok(reasons[0].length <= 240)
  assert.equal(/[\r\n]/u.test(reasons[0]), false)
  assert.match(reasons[0], /action=click category=destructive/u)
  assert.match(reasons[0], /app=dev\.zseven\.fixture/u)
  assert.match(reasons[0], /window=#17 title='Fixture Window'/u)
  assert.match(reasons[0], /target=AXButton/u)
  assert.match(reasons[0], /name='Delete account secondary'/u)
  assert.match(reasons[0], /id='delete-account'/u)
  assert.equal(reasons[0].includes('SENSITIVE_VALUE_SHOULD_NOT_LEAK'), false)
  assert.equal(reasons[0].includes('SENSITIVE_INPUT_SHOULD_NOT_LEAK'), false)
  assert.equal(reasons[0].includes(seen.targets[0].ref), false)
  assert.equal(reasons[0].includes(seen.observationId), false)
  assert.equal(reasons[0].includes('agent-a'), false)
  const observes = native.requests.filter(entry => entry.request.command === 'observe')
  const actions = native.requests.filter(entry => entry.request.command === 'act')
  assert.equal(observes.length, 3, 'initial observation plus pre-ask and post-grant preflights')
  assert.equal(actions.length, 1)
  const grant = actions[0].request.approval
  assert.equal(grant.outcome, 'allowed-once')
  assert.equal(grant.observationId, seen.observationId)
  assert.equal(grant.riskCode, 'dangerous-click')
  assert.equal(grant.observationFingerprint, seen.fingerprint)
  assert.match(grant.refDigest, /^[a-f0-9]{64}$/u)
  assert.match(grant.actionDigest, /^[a-f0-9]{64}$/u)
  assert.equal(
    grant.actionDigest,
    createHash('sha256').update('22:dsh-computer-action-v1|5:click').digest('hex'),
  )
  assert.match(grant.nonce, /^[A-Za-z0-9_-]{43}$/u)
  assert.equal('approval' in actions[0].request.action, false)
})

test('approval wait cannot mutate the immutable action snapshot or its grant binding', async () => {
  const native = new FakeNative()
  const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
  const seen = await controller.observe({}, { scopeId: 'agent-a' })
  const originalRef = seen.targets[0].ref
  const modifiers = ['command']
  const callerOwnedAction = { kind: 'key', ref: originalRef, key: 'Q', modifiers }
  const receipt = await controller.act(callerOwnedAction, {
    scopeId: 'agent-a',
    approval: {
      async request() {
        callerOwnedAction.ref = 'cu_attacker_replacement'
        callerOwnedAction.key = 'left'
        modifiers.splice(0, modifiers.length, 'option')
        return 'allowed-once'
      },
    },
  })

  assert.equal(receipt.status, 'unknown')
  assert.equal(receipt.ref, originalRef)
  const nativeAct = native.requests.find(entry => entry.request.command === 'act').request
  assert.deepEqual(nativeAct.action, { kind: 'key', key: 'q', modifiers: ['command'] })
  assert.equal(nativeAct.approval.riskCode, 'unsafe-key-chord')
  assert.equal(nativeAct.approval.observationFingerprint, seen.fingerprint)
  assert.equal(
    nativeAct.approval.actionDigest,
    createHash('sha256')
      .update('22:dsh-computer-action-v1|3:key|1:q|7:command')
      .digest('hex'),
  )
  assert.match(nativeAct.approval.nonce, /^[A-Za-z0-9_-]{43}$/u)
})

test('approval-stable fingerprint tolerates focus and unrelated static text changes', async () => {
  const risky = node({ name: 'Delete account', identifier: 'delete-account', value: 'armed', focused: false })
  const staticText = node({
    role: 'AXStaticText', name: 'Clock 10:00', identifier: 'clock', actions: [], value: '10:00',
    locator: [0, 2], frame: { x: 200, y: 40, width: 100, height: 20 },
  })
  const initial = observation({ nodes: [risky, staticText] })
  const changed = observation({
    capturedAt: '2026-08-24T00:00:01.000Z',
    nodes: [
      { ...risky, focused: true },
      { ...staticText, name: 'Clock 10:01', value: '10:01' },
    ],
  })
  let observeCount = 0
  const native = new FakeNative()
  const baseRequest = native.request.bind(native)
  native.request = async (request, options) => {
    if (request.command !== 'observe') return baseRequest(request, options)
    native.requests.push({ request: structuredClone(request), scopeId: options.scopeId })
    observeCount += 1
    return structuredClone(observeCount === 1 ? initial : changed)
  }
  const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
  const seen = await controller.observe({}, { scopeId: 'agent-a' })
  const receipt = await controller.act(
    { kind: 'click', ref: seen.targets[0].ref },
    { scopeId: 'agent-a', approval: { async request() { return 'allowed-once' } } },
  )
  assert.equal(receipt.status, 'unknown')
  assert.equal(native.requests.filter(entry => entry.request.command === 'act').length, 1)
})

test('approval-stable fingerprint rejects interactive value or label changes after approval', async t => {
  for (const changedField of ['value', 'name']) {
    await t.test(changedField, async () => {
      const risky = node({ name: 'Delete account', identifier: 'delete-account', value: 'armed' })
      const initial = observation({ nodes: [risky] })
      const changedNode = { ...risky, [changedField]: changedField === 'value' ? 'disarmed' : 'Delete workspace' }
      let observeCount = 0
      const native = new FakeNative()
      const baseRequest = native.request.bind(native)
      native.request = async (request, options) => {
        if (request.command !== 'observe') return baseRequest(request, options)
        native.requests.push({ request: structuredClone(request), scopeId: options.scopeId })
        observeCount += 1
        return structuredClone(observeCount < 3 ? initial : observation({ nodes: [changedNode] }))
      }
      const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
      const seen = await controller.observe({}, { scopeId: 'agent-a' })
      const receipt = await controller.act(
        { kind: 'click', ref: seen.targets[0].ref },
        { scopeId: 'agent-a', approval: { async request() { return 'allowed-once' } } },
      )
      assert.equal(receipt.status, 'rejected')
      assert.match(receipt.reason, /fingerprint changed/u)
      assert.equal(native.requests.filter(entry => entry.request.command === 'act').length, 0)
    })
  }
})

test('all non-grant approval outcomes and approval exceptions fail closed without native mutation', async t => {
  for (const outcome of ['rejected', 'cancelled', 'unavailable', 'throw']) {
    await t.test(outcome, async () => {
      const native = new FakeNative({ observation: observation({ nodes: [node({ name: 'Publish now' })] }) })
      const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
      const seen = await controller.observe({}, { scopeId: 'agent-a' })
      const receipt = await controller.act(
        { kind: 'click', ref: seen.targets[0].ref },
        {
          scopeId: 'agent-a',
          approval: {
            async request() {
              if (outcome === 'throw') throw new Error('answerer failed')
              return outcome
            },
          },
        },
      )
      assert.equal(receipt.status, 'rejected')
      assert.equal(receipt.nativeAccepted, false)
      assert.equal(native.requests.filter(entry => entry.request.command === 'act').length, 0)
      assert.equal(native.requests.filter(entry => entry.request.command === 'observe').length, 2)
    })
  }
})

test('an allowed-once grant is consumed if the observation expires while approval is pending', async () => {
  let now = 1_000
  const native = new FakeNative({ observation: observation({ nodes: [node({ name: 'Submit order' })] }) })
  const controller = new ComputerController({ native, now: () => now, id: ids(), platform: 'darwin' })
  const seen = await controller.observe({ ttlMs: 1_000 }, { scopeId: 'agent-a' })
  const receipt = await controller.act(
    { kind: 'click', ref: seen.targets[0].ref },
    {
      scopeId: 'agent-a',
      approval: { async request() { now = 2_001; return 'allowed-once' } },
    },
  )
  assert.equal(receipt.status, 'rejected')
  assert.match(receipt.reason, /approved action was not dispatched.*expired/u)
  assert.equal(native.requests.filter(entry => entry.request.command === 'act').length, 0)
  assert.equal(native.requests.filter(entry => entry.request.command === 'observe').length, 2)
})

test('an allowed-once grant is consumed when the live target changes from risky to safe', async () => {
  const native = new FakeNative({ observation: observation({ nodes: [node({ name: 'Delete account' })] }) })
  const baseRequest = native.request.bind(native)
  native.request = async (request, options) => {
    if (request.command === 'observe'
      && native.requests.filter(entry => entry.request.command === 'observe').length === 2) {
      native.requests.push({ request: structuredClone(request), scopeId: options.scopeId })
      return observation({ nodes: [node({ name: 'Open settings' })] })
    }
    return baseRequest(request, options)
  }
  const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
  const seen = await controller.observe({}, { scopeId: 'agent-a' })
  const receipt = await controller.act(
    { kind: 'click', ref: seen.targets[0].ref },
    { scopeId: 'agent-a', approval: { async request() { return 'allowed-once' } } },
  )
  assert.equal(receipt.status, 'rejected')
  assert.match(receipt.reason, /approved action was not dispatched after live revalidation/u)
  assert.equal(native.requests.filter(entry => entry.request.command === 'act').length, 0)
})

test('safe focus and navigation perform one live preflight without asking for approval', async t => {
  const actions = [
    { kind: 'focus' },
    { kind: 'key', key: 'left', modifiers: ['option'] },
  ]
  for (const action of actions) {
    await t.test(action.kind, async () => {
      const native = new FakeNative()
      const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
      const seen = await controller.observe({}, { scopeId: 'agent-a' })
      let approvalCalls = 0
      const receipt = await controller.act(
        { ...action, ref: seen.targets[0].ref },
        {
          scopeId: 'agent-a',
          approval: { async request() { approvalCalls += 1; return 'allowed-once' } },
        },
      )
      assert.notEqual(receipt.status, 'rejected')
      assert.equal(approvalCalls, 0)
      assert.equal(native.requests.filter(entry => entry.request.command === 'observe').length, 2)
      const nativeAct = native.requests.find(entry => entry.request.command === 'act')
      assert.equal(nativeAct.request.approval, null)
    })
  }
})

test('scroll is safe, dispatches once with a normalized amount, and reports an honest unknown receipt', async () => {
  const native = new FakeNative()
  const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
  const seen = await controller.observe({}, { scopeId: 'agent-a' })
  let approvalCalls = 0
  const receipt = await controller.act(
    { kind: 'scroll', ref: seen.targets[0].ref, direction: 'down' },
    {
      scopeId: 'agent-a',
      approval: { async request() { approvalCalls += 1; return 'allowed-once' } },
    },
  )
  assert.equal(receipt.status, 'unknown')
  assert.equal(receipt.action, 'scroll')
  assert.equal(receipt.nativeAccepted, true)
  assert.equal(approvalCalls, 0)
  assert.equal(native.requests.filter(entry => entry.request.command === 'observe').length, 2)
  const nativeAct = native.requests.find(entry => entry.request.command === 'act')
  assert.deepEqual(nativeAct.request.action, { kind: 'scroll', direction: 'down', amount: 'page' })
  assert.equal(nativeAct.request.approval, null)
})

test('scroll preserves an explicit amount and rejects invalid direction or amount before native dispatch', async t => {
  await t.test('explicit numeric amount', async () => {
    const native = new FakeNative()
    const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
    const seen = await controller.observe({}, { scopeId: 'agent-a' })
    const receipt = await controller.act(
      { kind: 'scroll', ref: seen.targets[0].ref, direction: 'up', amount: 120 }, { scopeId: 'agent-a' },
    )
    assert.equal(receipt.status, 'unknown')
    const nativeAct = native.requests.find(entry => entry.request.command === 'act')
    assert.deepEqual(nativeAct.request.action, { kind: 'scroll', direction: 'up', amount: 120 })
  })

  for (const bad of [
    { direction: 'sideways', amount: 'page' },
    { direction: 'down', amount: -3 },
    { direction: 'down', amount: 0 },
    { direction: 'down', amount: 'bogus' },
  ]) {
    await t.test(JSON.stringify(bad), async () => {
      const native = new FakeNative()
      const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
      const seen = await controller.observe({}, { scopeId: 'agent-a' })
      const receipt = await controller.act(
        { kind: 'scroll', ref: seen.targets[0].ref, ...bad }, { scopeId: 'agent-a' },
      )
      assert.equal(receipt.status, 'rejected')
      assert.equal(native.requests.filter(entry => entry.request.command === 'act').length, 0)
    })
  }
})

test('a scroll whose live target identity changed is rejected before native dispatch', async () => {
  const native = new FakeNative()
  let observeCount = 0
  const baseRequest = native.request.bind(native)
  native.request = async (request, options) => {
    if (request.command === 'observe' && ++observeCount > 1) {
      native.requests.push({ request: structuredClone(request), scopeId: options.scopeId })
      return observation({ nodes: [node({ name: 'Rebound target', identifier: 'different' })] })
    }
    return baseRequest(request, options)
  }
  const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
  const seen = await controller.observe({}, { scopeId: 'agent-a' })
  const receipt = await controller.act(
    { kind: 'scroll', ref: seen.targets[0].ref, direction: 'down' }, { scopeId: 'agent-a' },
  )
  assert.equal(receipt.status, 'rejected')
  assert.match(receipt.reason, /changed/)
  assert.equal(native.requests.filter(entry => entry.request.command === 'act').length, 0)
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
  assert.match(commit.reason, /commit key requires one-action host approval/)
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
    assert.match(receipt.reason, /safe navigation allowlist/)
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

test('session lock and missing Accessibility are rejected pre-dispatch, including after approval', async t => {
  for (const code of ['session_locked', 'accessibility_permission_required']) {
    await t.test(`${code}: safe action`, async () => {
      let observeCount = 0
      const native = new FakeNative()
      const baseRequest = native.request.bind(native)
      native.request = async (request, options) => {
        if (request.command === 'observe' && ++observeCount > 1) {
          throw new NativeHelperError(code, 'preflight unavailable', false)
        }
        return baseRequest(request, options)
      }
      const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
      const seen = await controller.observe({}, { scopeId: 'agent-a' })
      const receipt = await controller.act({ kind: 'focus', ref: seen.targets[0].ref }, { scopeId: 'agent-a' })
      assert.equal(receipt.status, 'rejected')
      assert.match(receipt.reason, new RegExp(code, 'u'))
      assert.equal(native.requests.filter(entry => entry.request.command === 'act').length, 0)
    })

    await t.test(`${code}: approved action`, async () => {
      let observeCount = 0
      const riskyObservation = observation({ nodes: [node({ name: 'Delete account' })] })
      const native = new FakeNative({ observation: riskyObservation })
      const baseRequest = native.request.bind(native)
      native.request = async (request, options) => {
        if (request.command === 'observe' && ++observeCount === 3) {
          throw new NativeHelperError(code, 'approved preflight unavailable', false)
        }
        return baseRequest(request, options)
      }
      const controller = new ComputerController({ native, now: () => 1_000, id: ids(), platform: 'darwin' })
      const seen = await controller.observe({}, { scopeId: 'agent-a' })
      const receipt = await controller.act(
        { kind: 'click', ref: seen.targets[0].ref },
        { scopeId: 'agent-a', approval: { async request() { return 'allowed-once' } } },
      )
      assert.equal(receipt.status, 'rejected')
      assert.match(receipt.reason, new RegExp(code, 'u'))
      assert.match(receipt.reason, /approved action was not dispatched/u)
      assert.equal(native.requests.filter(entry => entry.request.command === 'act').length, 0)
    })
  }
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
