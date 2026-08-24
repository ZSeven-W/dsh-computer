import assert from 'node:assert/strict'
import test from 'node:test'
import {
  commitVisualCapture,
  renderVisualObservation,
  requireImageCapableRoute,
} from '../lib/index.js'
import { app, windowIdentity } from './fixtures.mjs'

function capture() {
  return {
    observationId: 'obs_visual',
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
        classification: 'usable', usable: true, sampleCount: 10, visibleFraction: 1,
        meanLuminance: 0.5, luminanceVariance: 0.1, luminanceRange: 0.8,
        darkFraction: 0.1, lightFraction: 0.1, distinctColorBuckets: 8,
      },
    },
    marks: [],
    omitted: [],
  }
}

test('route gate falls back to Agent options only when request-header config is absent', async () => {
  const attachments = { async saveImage() { throw new Error('unused') } }
  let resolved
  const returned = await requireImageCapableRoute({
    getService(name) {
      if (name === 'attachments') return attachments
      return {
        async resolveModelInfo(provider, model) {
          resolved = { provider, model }
          return { inputModalities: ['image'] }
        },
      }
    },
  }, {
    agent: {
      session: { requestHeader: () => ({ config: {} }) },
      options: { provider: 'fallback-provider', model: 'fallback-vision' },
    },
  })

  assert.equal(returned, attachments)
  assert.deepEqual(resolved, { provider: 'fallback-provider', model: 'fallback-vision' })
})

test('route resolution exceptions fail clearly instead of degrading into a capture', async () => {
  await assert.rejects(requireImageCapableRoute({
    getService(name) {
      if (name === 'attachments') return { async saveImage() {} }
      return { async resolveModelInfo() { throw new Error('catalog unavailable') } }
    },
  }, {
    agent: { options: { provider: 'p', model: 'm' } },
  }), /could not resolve model "m".*catalog unavailable/u)
})

test('attachment references are validated and normalization metadata is retained', async () => {
  const value = await commitVisualCapture({
    async saveImage() {
      return {
        attachmentId: 'att-1', mediaType: 'image/jpeg', bytes: 999,
        width: 900, height: 700, originalDimensions: { width: 1800, height: 1400 },
      }
    },
  }, capture())
  assert.equal(value.image.mediaType, 'image/jpeg')
  assert.deepEqual(value.image.originalDimensions, { width: 1800, height: 1400 })
  assert.deepEqual(value.capture.attachmentScale, { x: 0.5, y: 0.5 })
  const rendered = renderVisualObservation({}, value)
  assert.deepEqual(rendered[1], { type: 'image', attachment: value.image })

  await assert.rejects(commitVisualCapture({
    async saveImage() {
      return { attachmentId: 'att-bad', mediaType: 'image/png', bytes: 1, width: -0, height: 1 }
    },
  }, capture()), /attachment width must be a positive safe integer/u)
})
