import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { captureNativeWindow, NativeCaptureArtifactError } from '../lib/capture-native.js'
import { app, node, windowIdentity } from './fixtures.mjs'

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fixture-png-payload'),
])

function quality(overrides = {}) {
  return {
    classification: 'usable',
    usable: true,
    sampleCount: 4_096,
    visibleFraction: 1,
    meanLuminance: 0.5,
    luminanceVariance: 0.08,
    luminanceRange: 1,
    darkFraction: 0.2,
    lightFraction: 0.2,
    distinctColorBuckets: 64,
    ...overrides,
  }
}

function result(overrides = {}) {
  return {
    capturedAt: '2026-08-24T00:00:00.000Z',
    app,
    window: windowIdentity,
    artifact: {
      format: 'png',
      byteLength: png.length,
      sha256: createHash('sha256').update(png).digest('hex'),
    },
    pointFrame: windowIdentity.frame,
    pixelWidth: 1_800,
    pixelHeight: 1_400,
    scaleX: 2,
    scaleY: 2,
    quality: quality(),
    marks: [{ number: 1, ref: 'agent-private-ref', index: 0, pixelFrame: { x: 40, y: 40, width: 240, height: 56 } }],
    omitted: [],
    ...overrides,
  }
}

function request() {
  return {
    id: 'capture-fixture',
    capture: {
      app,
      window: windowIdentity,
      targets: [{ ref: 'agent-private-ref', index: 0, element: node(), locator: [0, 1] }],
    },
  }
}

class CaptureTransport {
  constructor(writer, response = result()) {
    this.writer = writer
    this.response = response
    this.requests = []
  }

  async request(nativeRequest, options) {
    this.requests.push({ nativeRequest, options })
    await this.writer(nativeRequest.capture.outputPath)
    return this.response
  }

  active() { return 0 }
  async disposeScope() {}
  async dispose() {}
}

async function fixtureRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-computer-capture-test-'))
}

async function expectCaptureRejection(response, expectedCode, captureRequest = request()) {
  const root = await fixtureRoot()
  try {
    const transport = new CaptureTransport(path => writeFile(path, png, { mode: 0o600 }), response)
    await assert.rejects(
      captureNativeWindow(transport, captureRequest, { scopeId: 'agent-a' }, { temporaryRoot: root }),
      error => error instanceof NativeCaptureArtifactError && error.code === expectedCode,
    )
    assert.deepEqual(await readdir(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('window capture uses an explicit window number, verifies PNG, and removes native temp files', async () => {
  const root = await fixtureRoot()
  try {
    const transport = new CaptureTransport(path => writeFile(path, png, { mode: 0o600 }))
    const capture = await captureNativeWindow(
      transport,
      request(),
      { scopeId: 'agent-a' },
      { temporaryRoot: root },
    )
    assert.deepEqual(capture.png, png)
    assert.equal(capture.result.window.number, 17)
    assert.equal(transport.requests.length, 1)
    assert.equal(transport.requests[0].nativeRequest.command, 'capture')
    assert.equal(transport.requests[0].nativeRequest.capture.window.number, 17)
    assert.match(transport.requests[0].nativeRequest.capture.outputPath, /dsh-computer-capture-[^/]+\/capture\.png$/u)
    assert.deepEqual(await readdir(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('capture receipt hash mismatch fails closed and still cleans the workspace', async () => {
  const root = await fixtureRoot()
  try {
    const bad = result({ artifact: { format: 'png', byteLength: png.length, sha256: '0'.repeat(64) } })
    const transport = new CaptureTransport(path => writeFile(path, png, { mode: 0o600 }), bad)
    await assert.rejects(
      captureNativeWindow(transport, request(), { scopeId: 'agent-a' }, { temporaryRoot: root }),
      error => error instanceof NativeCaptureArtifactError && error.code === 'capture_integrity_failed',
    )
    assert.deepEqual(await readdir(root), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('capture refuses a symlink artifact and does not delete its external target', async () => {
  const root = await fixtureRoot()
  const external = join(root, 'external.png')
  await writeFile(external, png, { mode: 0o600 })
  try {
    const transport = new CaptureTransport(async outputPath => {
      await mkdir(dirname(outputPath), { recursive: true })
      await symlink(external, outputPath)
    })
    await assert.rejects(
      captureNativeWindow(transport, request(), { scopeId: 'agent-a' }, { temporaryRoot: root }),
      error => error instanceof NativeCaptureArtifactError && error.code === 'unsafe_capture_artifact',
    )
    await access(external)
    assert.deepEqual(await readdir(root), ['external.png'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('near-white and near-uniform warning classifications remain usable', async () => {
  for (const classification of ['near-white', 'near-uniform']) {
    const root = await fixtureRoot()
    try {
      const response = result({ quality: quality({ classification, luminanceVariance: 0, luminanceRange: 0 }) })
      const transport = new CaptureTransport(path => writeFile(path, png, { mode: 0o600 }), response)
      const capture = await captureNativeWindow(
        transport, request(), { scopeId: 'agent-a' }, { temporaryRoot: root },
      )
      assert.equal(capture.result.quality.classification, classification)
      assert.equal(capture.result.quality.usable, true)
      assert.deepEqual(await readdir(root), [])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

test('marks and omissions must form one complete, disjoint partition of requested targets', async () => {
  const second = { ref: 'second-private-ref', index: 1, element: node({ identifier: 'second' }), locator: [0, 2] }
  const twoTargets = request()
  twoTargets.capture.targets.push(second)
  const partitioned = result({
    omitted: [{ ref: second.ref, index: second.index, reason: 'target_outside_captured_window' }],
  })
  const root = await fixtureRoot()
  try {
    const transport = new CaptureTransport(path => writeFile(path, png, { mode: 0o600 }), partitioned)
    const capture = await captureNativeWindow(
      transport, twoTargets, { scopeId: 'agent-a' }, { temporaryRoot: root },
    )
    assert.equal(capture.result.marks.length, 1)
    assert.equal(capture.result.omitted.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  await expectCaptureRejection(result({ marks: [], omitted: [] }), 'invalid_capture_metadata')
  await expectCaptureRejection(result({
    omitted: [{ ref: 'agent-private-ref', index: 0, reason: 'duplicate' }],
  }), 'invalid_capture_metadata')
  await expectCaptureRejection(result({
    marks: [], omitted: [{ ref: 'agent-private-ref', index: 0, reason: '' }],
  }), 'invalid_capture_metadata')
})

test('window identity, timestamp, and quality numbers are independently validated', async () => {
  await expectCaptureRejection(result({
    window: { ...windowIdentity, role: 'AXDialog' },
  }), 'capture_identity_mismatch')
  await expectCaptureRejection(result({
    window: { ...windowIdentity, title: 'Rebound Window' },
  }), 'capture_identity_mismatch')
  await expectCaptureRejection(result({
    window: { ...windowIdentity, frame: { ...windowIdentity.frame, x: windowIdentity.frame.x + 4 } },
  }), 'capture_identity_mismatch')
  await expectCaptureRejection(result({ capturedAt: 'not-a-timestamp' }), 'invalid_capture_metadata')
  await expectCaptureRejection(result({
    quality: quality({ visibleFraction: Number.NaN }),
  }), 'invalid_capture_metadata')
})
