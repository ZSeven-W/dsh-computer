import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import type {
  NativeCaptureInput,
  NativeCaptureResult,
  NativeRequest,
  NativeTransport,
} from './native-protocol.js'

const MAX_CAPTURE_BYTES = 64 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CAPTURE_CLASSIFICATIONS = new Set([
  'usable', 'transparent', 'mostly-transparent', 'near-black', 'near-white', 'near-uniform',
])
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u

export class NativeCaptureArtifactError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'NativeCaptureArtifactError'
  }
}

export interface NativeWindowCapture {
  result: NativeCaptureResult
  /** Verified in-memory PNG; the temporary native artifact has already been removed. */
  png: Buffer
}

export interface NativeCaptureRequest {
  id: string
  capture: Omit<NativeCaptureInput, 'outputPath'>
}

interface CaptureRuntimeOptions {
  /** Test seam. Production callers must omit this so the OS user temp root is used. */
  temporaryRoot?: string
}

function assertLosslessNumber(
  value: number,
  name: string,
  options: { minimum?: number; maximum?: number; integer?: boolean } = {},
): void {
  if (!Number.isFinite(value) || Object.is(value, -0)
      || (options.integer === true && !Number.isSafeInteger(value))
      || (options.minimum !== undefined && value < options.minimum)
      || (options.maximum !== undefined && value > options.maximum)) {
    throw new NativeCaptureArtifactError('invalid_capture_metadata', `${name} is not a lossless number inside its expected range`)
  }
}

function assertFinitePositive(value: number, name: string): void {
  try {
    assertLosslessNumber(value, name, { minimum: Number.MIN_VALUE })
  } catch {
    throw new NativeCaptureArtifactError('invalid_capture_metadata', `${name} must be a finite positive number`)
  }
}

function approximatelyEqual(left: number, right: number, tolerance = 1): boolean {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance
}

function assertFrame(
  frame: { x: number; y: number; width: number; height: number },
  name: string,
): void {
  if (typeof frame !== 'object' || frame === null) {
    throw new NativeCaptureArtifactError('invalid_capture_metadata', `${name} is missing`)
  }
  assertLosslessNumber(frame.x, `${name}.x`)
  assertLosslessNumber(frame.y, `${name}.y`)
  assertFinitePositive(frame.width, `${name}.width`)
  assertFinitePositive(frame.height, `${name}.height`)
}

function framesApproximatelyEqual(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
  tolerance: number,
): boolean {
  return approximatelyEqual(left.x, right.x, tolerance)
    && approximatelyEqual(left.y, right.y, tolerance)
    && approximatelyEqual(left.width, right.width, tolerance)
    && approximatelyEqual(left.height, right.height, tolerance)
}

function assertTimestamp(value: string): void {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new NativeCaptureArtifactError('invalid_capture_metadata', 'capturedAt is not a basic UTC ISO-8601 timestamp')
  }
}

function assertBoundedString(value: string, name: string, maximum: number): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || value.includes('\u0000')) {
    throw new NativeCaptureArtifactError('invalid_capture_metadata', `${name} is missing or outside its length boundary`)
  }
}

function validateResult(result: NativeCaptureResult, expected: Omit<NativeCaptureInput, 'outputPath'>): void {
  assertTimestamp(result.capturedAt)
  if (result.artifact.format !== 'png') {
    throw new NativeCaptureArtifactError('invalid_capture_metadata', 'native capture format is not PNG')
  }
  if (!Number.isSafeInteger(result.artifact.byteLength)
      || result.artifact.byteLength < PNG_SIGNATURE.length
      || result.artifact.byteLength > MAX_CAPTURE_BYTES) {
    throw new NativeCaptureArtifactError('invalid_capture_metadata', 'native capture byte length is outside the safety boundary')
  }
  if (!/^[a-f0-9]{64}$/u.test(result.artifact.sha256)) {
    throw new NativeCaptureArtifactError('invalid_capture_metadata', 'native capture SHA-256 is malformed')
  }
  assertLosslessNumber(result.pixelWidth, 'pixelWidth', { minimum: 1, maximum: 65_535, integer: true })
  assertLosslessNumber(result.pixelHeight, 'pixelHeight', { minimum: 1, maximum: 65_535, integer: true })
  assertFrame(result.pointFrame, 'pointFrame')
  assertFinitePositive(result.scaleX, 'scaleX')
  assertFinitePositive(result.scaleY, 'scaleY')
  assertLosslessNumber(result.app.pid, 'app.pid', { minimum: 1, integer: true })
  assertBoundedString(result.app.bundleId, 'app.bundleId', 512)
  if (result.app.bundleId !== expected.app.bundleId
      || result.app.pid !== expected.app.pid
      || result.app.launchIdentity !== expected.app.launchIdentity) {
    throw new NativeCaptureArtifactError('capture_identity_mismatch', 'native capture application identity differs from the request')
  }
  assertLosslessNumber(result.window.number, 'window.number', { minimum: 1, maximum: 0xffff_ffff, integer: true })
  assertBoundedString(result.window.role, 'window.role', 240)
  assertBoundedString(result.window.identity, 'window.identity', 256)
  assertFrame(result.window.frame, 'window.frame')
  if (result.window.number !== expected.window.number
      || result.window.identity !== expected.window.identity
      || result.window.role !== expected.window.role
      || result.window.subrole !== expected.window.subrole
      || result.window.title !== expected.window.title
      || !framesApproximatelyEqual(result.window.frame, expected.window.frame, 1)) {
    throw new NativeCaptureArtifactError('capture_identity_mismatch', 'native capture window identity differs from the request')
  }
  if (!framesApproximatelyEqual(result.pointFrame, result.window.frame, 2)) {
    throw new NativeCaptureArtifactError('capture_identity_mismatch', 'native capture point frame differs from its live window identity')
  }
  if (!approximatelyEqual(result.scaleX, result.pixelWidth / result.pointFrame.width, 1e-9)
      || !approximatelyEqual(result.scaleY, result.pixelHeight / result.pointFrame.height, 1e-9)) {
    throw new NativeCaptureArtifactError('invalid_capture_metadata', 'native capture scale does not match its point and pixel dimensions')
  }
  if (typeof result.quality !== 'object' || result.quality === null
      || !CAPTURE_CLASSIFICATIONS.has(result.quality.classification)) {
    throw new NativeCaptureArtifactError('invalid_capture_metadata', 'native capture quality classification is invalid')
  }
  if (typeof result.quality.usable !== 'boolean') {
    throw new NativeCaptureArtifactError('invalid_capture_metadata', 'native capture quality usability flag is invalid')
  }
  assertLosslessNumber(result.quality.sampleCount, 'quality.sampleCount', { minimum: 1, maximum: 4_096, integer: true })
  assertLosslessNumber(result.quality.visibleFraction, 'quality.visibleFraction', { minimum: 0, maximum: 1 })
  assertLosslessNumber(result.quality.meanLuminance, 'quality.meanLuminance', { minimum: 0, maximum: 1 })
  assertLosslessNumber(result.quality.luminanceVariance, 'quality.luminanceVariance', { minimum: 0, maximum: 1 })
  assertLosslessNumber(result.quality.luminanceRange, 'quality.luminanceRange', { minimum: 0, maximum: 1 })
  assertLosslessNumber(result.quality.darkFraction, 'quality.darkFraction', { minimum: 0, maximum: 1 })
  assertLosslessNumber(result.quality.lightFraction, 'quality.lightFraction', { minimum: 0, maximum: 1 })
  assertLosslessNumber(result.quality.distinctColorBuckets, 'quality.distinctColorBuckets', {
    minimum: 0,
    maximum: Math.min(512, result.quality.sampleCount),
    integer: true,
  })
  if (!result.quality.usable) {
    throw new NativeCaptureArtifactError('capture_unusable', 'native capture did not pass pixel-level usability validation')
  }
  if (!Array.isArray(expected.targets) || !Array.isArray(result.marks) || !Array.isArray(result.omitted)) {
    throw new NativeCaptureArtifactError('invalid_capture_metadata', 'capture target partition must use arrays')
  }

  const requested = new Map<string, number>()
  const requestedIndices = new Set<number>()
  for (const target of expected.targets) {
    assertBoundedString(target.ref, 'requested target ref', 256)
    assertLosslessNumber(target.index, 'requested target index', { minimum: 0, maximum: 499, integer: true })
    if (requested.has(target.ref) || requestedIndices.has(target.index)) {
      throw new NativeCaptureArtifactError('invalid_capture_metadata', 'requested target refs and indices must be unique')
    }
    requested.set(target.ref, target.index)
    requestedIndices.add(target.index)
  }
  const numbers = new Set<number>()
  const partitionRefs = new Set<string>()
  const partitionIndices = new Set<number>()
  for (const [offset, mark] of result.marks.entries()) {
    if (!Number.isSafeInteger(mark.number) || mark.number !== offset + 1 || numbers.has(mark.number)) {
      throw new NativeCaptureArtifactError('invalid_capture_metadata', 'Set-of-Mark numbers must be unique positive integers')
    }
    if (!mark.ref || partitionRefs.has(mark.ref) || partitionIndices.has(mark.index)
        || requested.get(mark.ref) !== mark.index) {
      throw new NativeCaptureArtifactError('invalid_capture_metadata', 'Set-of-Mark refs must be non-empty and unique')
    }
    assertFrame(mark.pixelFrame, 'mark.pixelFrame')
    if (mark.pixelFrame.x < 0 || mark.pixelFrame.y < 0
        || mark.pixelFrame.x + mark.pixelFrame.width > result.pixelWidth
        || mark.pixelFrame.y + mark.pixelFrame.height > result.pixelHeight) {
      throw new NativeCaptureArtifactError('invalid_capture_metadata', 'Set-of-Mark frame falls outside the captured window')
    }
    numbers.add(mark.number)
    partitionRefs.add(mark.ref)
    partitionIndices.add(mark.index)
  }
  for (const omission of result.omitted) {
    assertBoundedString(omission.ref, 'omitted target ref', 256)
    assertLosslessNumber(omission.index, 'omitted target index', { minimum: 0, maximum: 499, integer: true })
    assertBoundedString(omission.reason, 'omitted target reason', 512)
    if (omission.reason.trim().length === 0 || /[\u0000-\u001f\u007f]/u.test(omission.reason)
        || partitionRefs.has(omission.ref) || partitionIndices.has(omission.index)
        || requested.get(omission.ref) !== omission.index) {
      throw new NativeCaptureArtifactError('invalid_capture_metadata', 'omitted targets must be valid and disjoint from marks')
    }
    partitionRefs.add(omission.ref)
    partitionIndices.add(omission.index)
  }
  if (partitionRefs.size !== requested.size || partitionIndices.size !== requestedIndices.size) {
    throw new NativeCaptureArtifactError(
      'invalid_capture_metadata',
      'marks and omitted targets do not form a complete partition of requested targets',
    )
  }
}

async function readVerifiedArtifact(
  root: string,
  outputPath: string,
  result: NativeCaptureResult,
  expected: Omit<NativeCaptureInput, 'outputPath'>,
): Promise<Buffer> {
  validateResult(result, expected)
  const [resolvedRoot, metadata] = await Promise.all([realpath(root), lstat(outputPath)])
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new NativeCaptureArtifactError('unsafe_capture_artifact', 'native capture artifact is not a single regular file')
  }
  if (typeof process.geteuid === 'function' && metadata.uid !== process.geteuid()) {
    throw new NativeCaptureArtifactError('unsafe_capture_artifact', 'native capture artifact has an unexpected owner')
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new NativeCaptureArtifactError('unsafe_capture_artifact', 'native capture artifact is readable outside its owner')
  }
  if (metadata.size !== result.artifact.byteLength) {
    throw new NativeCaptureArtifactError('capture_integrity_failed', 'native capture byte length does not match its receipt')
  }

  const handle = await open(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino || opened.nlink !== 1) {
      throw new NativeCaptureArtifactError('unsafe_capture_artifact', 'native capture artifact changed before it could be read')
    }
    const resolvedOutput = await realpath(outputPath)
    if (!resolvedOutput.startsWith(`${resolvedRoot}${sep}`)) {
      throw new NativeCaptureArtifactError('unsafe_capture_artifact', 'native capture artifact escaped its temporary directory')
    }
    const png = await handle.readFile()
    if (png.length !== result.artifact.byteLength || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new NativeCaptureArtifactError('capture_integrity_failed', 'native capture is not the declared PNG artifact')
    }
    const digest = createHash('sha256').update(png).digest('hex')
    if (digest !== result.artifact.sha256) {
      throw new NativeCaptureArtifactError('capture_integrity_failed', 'native capture SHA-256 does not match its receipt')
    }
    return png
  } finally {
    await handle.close()
  }
}

/**
 * Runs one window capture with a caller-created mode-0700 workspace. The Swift
 * helper may write only `capture.png`; this wrapper verifies and removes it
 * before returning the in-memory PNG to the attachment service.
 */
export async function captureNativeWindow(
  transport: NativeTransport,
  request: NativeCaptureRequest,
  options: { scopeId: string; signal?: AbortSignal },
  runtime: CaptureRuntimeOptions = {},
): Promise<NativeWindowCapture> {
  const base = runtime.temporaryRoot ?? tmpdir()
  const root = await mkdtemp(join(base, 'dsh-computer-capture-'))
  await chmod(root, 0o700)
  const outputPath = join(root, 'capture.png')
  const nativeRequest: NativeRequest = {
    id: request.id,
    command: 'capture',
    capture: { ...request.capture, outputPath },
  }
  try {
    const result = await transport.request<NativeCaptureResult>(nativeRequest, options)
    const png = await readVerifiedArtifact(root, outputPath, result, request.capture)
    return { result, png }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
