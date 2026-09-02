import assert from 'node:assert/strict'
import test from 'node:test'
import { createComputerTools } from '../lib/index.js'
import { app, windowIdentity } from './fixtures.mjs'

function driver() {
  return {
    kind: 'computer', platform: 'macos', contractVersion: 4,
    async observe() { throw new Error('not reached') },
    async visualObserve() { throw new Error('not reached') },
    async act() { throw new Error('not reached') },
    async evidence() { throw new Error('not reached') },
    async disposeScope() {}, async dispose() {},
  }
}

function visualCapture() {
  return {
    observationId: 'obs_private',
    observationFingerprint: 'f'.repeat(64),
    capturedAt: '2026-08-24T00:00:00.050Z',
    expiresAt: '2026-08-24T00:00:15.000Z',
    app,
    window: windowIdentity,
    png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    capture: {
      artifact: { format: 'png', byteLength: 4, sha256: 'a'.repeat(64) },
      pointFrame: windowIdentity.frame,
      pixelWidth: 1800,
      pixelHeight: 1400,
      scaleX: 2,
      scaleY: 2,
      quality: {
        classification: 'near-white', usable: true, sampleCount: 100, visibleFraction: 1,
        meanLuminance: 0.95, luminanceVariance: 0.01, luminanceRange: 0.1,
        darkFraction: 0, lightFraction: 0.9, distinctColorBuckets: 8,
      },
    },
    marks: [{
      number: 1, ref: 'cu_private', sourceIndex: 3,
      nativePixelFrame: { x: 100, y: 200, width: 300, height: 80 },
    }],
    omitted: [{ ref: 'cu_omitted', sourceIndex: 5, reason: 'outside captured window' }],
  }
}

function execution(overrides = {}) {
  return {
    callId: 'call-visual',
    signal: new AbortController().signal,
    agent: {
      id: 'agent-a',
      session: { requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'vision-route' } }) },
      options: { provider: 'fallback-provider', model: 'fallback-model' },
    },
    ...overrides,
  }
}

function assertLosslessJson(value) {
  const visit = item => {
    if (typeof item === 'number') {
      assert.equal(Number.isFinite(item), true)
      assert.equal(Object.is(item, -0), false)
      return
    }
    if (Array.isArray(item)) return item.forEach(visit)
    if (item !== null && typeof item === 'object') {
      assert.equal(item instanceof Uint8Array, false, 'tool JSON must not contain screenshot bytes')
      for (const [key, child] of Object.entries(item)) {
        assert.notEqual(child, undefined, `undefined at ${key}`)
        visit(child)
      }
    }
  }
  visit(value)
  assert.doesNotThrow(() => JSON.stringify(value))
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
  assert.deepEqual(tools.computerVisualObserve.parameters.required, ['observation_id'])
  assert.deepEqual(Object.keys(tools.computerVisualObserve.parameters.properties).sort(), [
    'max_marks', 'observation_id',
  ])
  for (const forbidden of ['path', 'file_path', 'window', 'window_number', 'ref', 'app_bundle_id', 'approved']) {
    assert.equal(forbidden in tools.computerVisualObserve.parameters.properties, false)
  }
  assert.equal('approval' in tools.computerAct.parameters.properties, false)
  assert.equal('approved' in tools.computerAct.parameters.properties, false)
  assert.equal('risk' in tools.computerAct.parameters.properties, false)
  assert.deepEqual(
    tools.computerAct.parameters.properties.action.enum,
    ['click', 'focus', 'type', 'key', 'scroll'],
  )
  assert.equal('direction' in tools.computerAct.parameters.properties, true)
  assert.equal('amount' in tools.computerAct.parameters.properties, true)
})

test('computer_act parses scroll into the bound driver action and validates its inputs', async () => {
  const fake = driver()
  const received = []
  fake.act = async action => { received.push(action); return { status: 'unknown' } }
  const tools = createComputerTools(fake)
  const exec = execution()

  await tools.computerAct.execute({ action: 'scroll', ref: 'cu_private', direction: 'down' }, exec)
  assert.deepEqual(received.at(-1), { kind: 'scroll', ref: 'cu_private', direction: 'down' })
  await tools.computerAct.execute({ action: 'scroll', ref: 'cu_private', direction: 'up', amount: 'page' }, exec)
  assert.deepEqual(received.at(-1), { kind: 'scroll', ref: 'cu_private', direction: 'up', amount: 'page' })
  await tools.computerAct.execute({ action: 'scroll', ref: 'cu_private', direction: 'down', amount: 150 }, exec)
  assert.deepEqual(received.at(-1), { kind: 'scroll', ref: 'cu_private', direction: 'down', amount: 150 })

  await assert.rejects(
    tools.computerAct.execute({ action: 'scroll', ref: 'cu_private', direction: 'sideways' }, exec),
    /direction is required/u,
  )
  await assert.rejects(
    tools.computerAct.execute({ action: 'scroll', ref: 'cu_private', direction: 'down', amount: -1 }, exec),
    /amount must be line, page, or a positive number/u,
  )
})

test('text-only exact route is rejected before native capture or attachment write', async () => {
  let captures = 0
  let saves = 0
  const fake = driver()
  fake.visualObserve = async () => { captures += 1; return visualCapture() }
  const tools = createComputerTools(fake, {
    getService(name) {
      if (name === 'attachments') return { async saveImage() { saves += 1; throw new Error('must not run') } }
      return {
        async resolveModelInfo(provider, model) {
          assert.equal(provider, 'deepseek-official')
          assert.equal(model, 'vision-route')
          return { inputModalities: ['text'] }
        },
      }
    },
  })

  await assert.rejects(
    tools.computerVisualObserve.execute({ observation_id: 'obs_private' }, execution()),
    /does not declare image input/u,
  )
  assert.equal(captures, 0)
  assert.equal(saves, 0)
})

test('visual services are resolved lazily per execution and image output is durable, lossless and rendered', async () => {
  const fake = driver()
  const contexts = []
  fake.visualObserve = async (request, context) => {
    assert.deepEqual(request, { observationId: 'obs_private', maxMarks: 12 })
    contexts.push(context)
    return visualCapture()
  }
  let attachments
  let llm
  const lookups = []
  const tools = createComputerTools(fake, {
    getService(name) {
      lookups.push(name)
      return name === 'attachments' ? attachments : llm
    },
  })

  attachments = {
    async saveImage(input) {
      assert.equal(input.mediaType, 'image/png')
      assert.equal(input.name, 'dsh-computer-window.png')
      assert.deepEqual([...input.data], [0x89, 0x50, 0x4e, 0x47])
      return {
        attachmentId: 'att_visual', mediaType: 'image/webp', bytes: 1234,
        width: 900, height: 700, name: 'normalized.webp',
        originalDimensions: { width: 1800, height: 1400 },
      }
    },
  }
  const exec = execution()
  llm = {
    async resolveModelInfo(provider, model, signal) {
      assert.equal(provider, 'deepseek-official', 'request-header route wins over Agent options')
      assert.equal(model, 'vision-route')
      assert.equal(signal, exec.signal)
      return { inputModalities: ['text', 'image'] }
    },
  }
  const value = await tools.computerVisualObserve.execute(
    { observation_id: 'obs_private', max_marks: 12 }, exec,
  )

  assert.deepEqual(lookups, ['attachments', 'llm'])
  assert.equal(contexts[0].scopeId, 'agent-a')
  assert.equal(contexts[0].signal, exec.signal)
  assert.deepEqual(value.image, {
    attachmentId: 'att_visual', mediaType: 'image/webp', bytes: 1234,
    width: 900, height: 700, name: 'normalized.webp',
    originalDimensions: { width: 1800, height: 1400 },
  })
  assert.deepEqual(value.capture.nativePixels, { width: 1800, height: 1400 })
  assert.deepEqual(value.capture.attachmentPixels, { width: 900, height: 700 })
  assert.deepEqual(value.capture.attachmentScale, { x: 0.5, y: 0.5 })
  assert.deepEqual(value.marks[0].attachmentPixelFrame, { x: 50, y: 100, width: 150, height: 40 })
  assert.equal(value.marks[0].ref, 'cu_private')
  assert.equal(value.marks[0].sourceIndex, 3)
  assert.equal('png' in value, false)
  assert.equal('path' in value, false)
  assert.equal('base64' in value, false)
  assertLosslessJson(value)

  const blocks = tools.computerVisualObserve.output.render({}, value)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].type, 'text')
  assert.deepEqual(blocks[1], { type: 'image', attachment: value.image })
})

test('attachment failure rejects the dedicated visual tool after capture without corrupting AX tools', async () => {
  let captures = 0
  const fake = driver()
  fake.visualObserve = async () => { captures += 1; return visualCapture() }
  fake.observe = async () => ({ ok: 'ax-still-works' })
  const tools = createComputerTools(fake, {
    getService(name) {
      if (name === 'llm') return { async resolveModelInfo() { return { inputModalities: ['image'] } } }
      return { async saveImage() { throw new Error('store offline') } }
    },
  })

  await assert.rejects(
    tools.computerVisualObserve.execute({ observation_id: 'obs_private' }, execution()),
    /could not persist.*store offline/u,
  )
  assert.equal(captures, 1)
  assert.deepEqual(
    await tools.computerObserve.execute({}, execution()),
    { ok: 'ax-still-works' },
  )
})

test('visual cancellation preserves AbortError reason at route, capture, and attachment boundaries', async t => {
  await t.test('after route gate', async () => {
    const abort = new AbortController()
    const reason = Object.assign(new Error('cancel after route'), { name: 'AbortError' })
    let captures = 0
    const fake = driver()
    fake.visualObserve = async () => { captures += 1; return visualCapture() }
    const tools = createComputerTools(fake, {
      getService(name) {
        if (name === 'attachments') return { async saveImage() { throw new Error('must not save') } }
        return {
          async resolveModelInfo() {
            abort.abort(reason)
            return { inputModalities: ['image'] }
          },
        }
      },
    })
    await assert.rejects(
      tools.computerVisualObserve.execute(
        { observation_id: 'obs_private' }, execution({ signal: abort.signal }),
      ),
      error => { assert.equal(error, reason); return true },
    )
    assert.equal(captures, 0)
  })

  await t.test('after native capture', async () => {
    const abort = new AbortController()
    const reason = Object.assign(new Error('cancel after capture'), { name: 'AbortError' })
    let saves = 0
    const fake = driver()
    fake.visualObserve = async () => {
      abort.abort(reason)
      return visualCapture()
    }
    const tools = createComputerTools(fake, {
      getService(name) {
        if (name === 'llm') return { async resolveModelInfo() { return { inputModalities: ['image'] } } }
        return { async saveImage() { saves += 1; throw new Error('must not save') } }
      },
    })
    await assert.rejects(
      tools.computerVisualObserve.execute(
        { observation_id: 'obs_private' }, execution({ signal: abort.signal }),
      ),
      error => { assert.equal(error, reason); return true },
    )
    assert.equal(saves, 0)
  })

  await t.test('after attachment persistence', async () => {
    const abort = new AbortController()
    const reason = Object.assign(new Error('cancel while saving'), { name: 'AbortError' })
    const fake = driver()
    fake.visualObserve = async () => visualCapture()
    let saves = 0
    const tools = createComputerTools(fake, {
      getService(name) {
        if (name === 'llm') return { async resolveModelInfo() { return { inputModalities: ['image'] } } }
        return {
          async saveImage() {
            saves += 1
            abort.abort(reason)
            return { attachmentId: 'att-cancelled', mediaType: 'image/png', bytes: 4, width: 1, height: 1 }
          },
        }
      },
    })
    await assert.rejects(
      tools.computerVisualObserve.execute(
        { observation_id: 'obs_private' }, execution({ signal: abort.signal }),
      ),
      error => { assert.equal(error, reason); return true },
    )
    assert.equal(saves, 1, 'storage may complete, but the cancelled result must not enter history')
  })
})

test('visual direct execution rejects injected path/window/ref arguments', async () => {
  const tools = createComputerTools(driver())
  for (const injected of [{ path: '/tmp/a.png' }, { window_number: 1 }, { ref: 'cu_private' }]) {
    await assert.rejects(
      tools.computerVisualObserve.execute({ observation_id: 'obs_private', ...injected }, execution()),
      /unexpected argument/u,
    )
  }
})

test('every raw tool executor enforces additionalProperties false without relying on ToolRuntime', async () => {
  const tools = createComputerTools(driver())
  const exec = execution()
  const attempts = [
    [tools.computerObserve, { unexpected: true }],
    [tools.computerVisualObserve, { observation_id: 'obs_private', unexpected: true }],
    [tools.computerAct, { action: 'click', ref: 'cu_private', approved: true }],
    [tools.computerEvidence, { risk: 'safe' }],
  ]
  for (const [tool, args] of attempts) {
    await assert.rejects(tool.execute(args, exec), /unexpected argument/u, tool.name)
  }
})

test('model tools reject missing Agent identity instead of sharing an agentless scope', async () => {
  const tools = createComputerTools(driver())
  await assert.rejects(
    tools.computerEvidence.execute({}, { rootCallId: 'call-1', signal: new AbortController().signal }),
    /requires a live Agent identity/,
  )
})

test('computer_act binds approval only from exact execute Agent/callId and lazily resolves the host service', async () => {
  const agent = { id: 'agent-a', marker: Symbol('same-object') }
  const signal = new AbortController().signal
  let driverContext
  const fake = driver()
  fake.act = async (_action, context) => {
    driverContext = context
    return context.approval.request('generated reason')
  }
  let getterCalls = 0
  let approvalRequest
  const tools = createComputerTools(fake, {
    getApproval() {
      getterCalls += 1
      return {
        async request(request) {
          approvalRequest = request
          return 'allowed-once'
        },
      }
    },
  })

  const result = await tools.computerAct.execute(
    { action: 'click', ref: 'cu_private' },
    { callId: 'call-exact', rootCallId: 'root-other', agent, signal },
  )
  assert.equal(result, 'allowed-once')
  assert.equal(getterCalls, 1)
  assert.equal(driverContext.scopeId, 'agent-a')
  assert.equal(approvalRequest.agent, agent)
  assert.equal(approvalRequest.callId, 'call-exact')
  assert.equal(approvalRequest.toolName, 'computer_act')
  assert.equal(approvalRequest.reason, 'generated reason')
  assert.equal(approvalRequest.signal, signal)
})

test('missing execute callId makes an approval request unavailable without touching the host service', async () => {
  const fake = driver()
  fake.act = async (_action, context) => context.approval.request('generated reason')
  let getterCalls = 0
  const tools = createComputerTools(fake, {
    getApproval() { getterCalls += 1; throw new Error('must stay lazy') },
  })
  const outcome = await tools.computerAct.execute(
    { action: 'click', ref: 'cu_private' },
    { agent: { id: 'agent-a' }, signal: new AbortController().signal },
  )
  assert.equal(outcome, 'unavailable')
  assert.equal(getterCalls, 0)
})
