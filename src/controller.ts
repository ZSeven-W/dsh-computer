import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type {
  ComputerAction,
  ComputerActionReceipt,
  ComputerAppList,
  ComputerLaunchRequest,
  ComputerLaunchResult,
  ComputerRunningApp,
  ComputerActionStatus,
  ComputerCapturableWindowIdentity,
  ComputerDriver,
  ComputerDriverContext,
  ComputerEvidence,
  ComputerHelperStatus,
  ComputerObservation,
  ComputerObserveRequest,
  ComputerOmittedReason,
  ComputerPoint,
  ComputerPostActionObservation,
  ComputerScrollAmount,
  ComputerTarget,
  ComputerVisualAction,
  ComputerVisualActionReceipt,
  ComputerVisualCapture,
  ComputerVisualObserveRequest,
} from './contracts.js'
import { COMPUTER_DRIVER_CONTRACT_VERSION } from './contracts.js'
import { captureNativeWindow } from './capture-native.js'
import { ComputerPlatformError, NativeHelper, NativeHelperError } from './native-helper.js'
import type {
  NativeActionPayload,
  NativeApprovalGrant,
  NativeActionResult,
  NativeAppsResult,
  NativeLaunchResult,
  NativeCaptureTarget,
  NativeElementIdentity,
  NativeObserveResult,
  NativeObservedNode,
  NativeStatusResult,
  NativeTransport,
  NativeVisualActionPayload,
  NativeVisualActResult,
} from './native-protocol.js'
import {
  classifyComputerActionRisk,
  normalizeKeyName,
  normalizeModifiers,
  type ComputerActionRisk,
} from './policy.js'

const DEFAULT_MAX_DEPTH = 4
const DEFAULT_MAX_NODES = 200
const DEFAULT_TTL_MS = 15_000
const MIN_TTL_MS = 1_000
const MAX_TTL_MS = 30_000
// Observation eviction is TTL-first: #cleanExpired removes expired
// observations, and this count is only a generous memory ceiling that evicts
// the OLDEST TTL-valid observation when a scope still exceeds it. A TTL-valid
// ref therefore survives any realistic settle/poll pattern (>=50 later observes
// within one TTL) and is only evicted far past this bound with a distinct
// OBSERVATION_EVICTED receipt instead of a false "unknown reference".
const MAX_OBSERVATIONS_PER_SCOPE = 512
// Aggregate memory ceiling per Agent scope, estimated from the serialized
// native observation payload (see estimateObservationBytes). When inserting a
// new observation would exceed it, the OLDEST TTL-valid observations are
// evicted first and recorded as OBSERVATION_EVICTED; the most recent
// observation is never evicted by this budget. The estimate bounds the
// retained payload text, not a precise heap measurement.
const MAX_OBSERVATION_BYTES_PER_SCOPE = 32 * 1024 * 1024
const MAX_RECEIPTS_PER_SCOPE = 100
// One tombstone entry per evicted OBSERVATION (refs carry their observation's
// token, see refObservationToken), so 600 observations of 500 nodes each
// cannot overflow the diagnostic set the way a per-ref FIFO did.
const MAX_EVICTED_OBSERVATIONS = 16_384
const MAX_TYPE_LENGTH = 8_192
const DEFAULT_MAX_MARKS = 80
const MAX_MARKS = 200

const INTERACTIVE_AX_ROLES = new Set([
  'AXButton',
  'AXCheckBox',
  'AXComboBox',
  'AXDisclosureTriangle',
  'AXLink',
  'AXMenuItem',
  'AXPopUpButton',
  'AXRadioButton',
  'AXSearchField',
  'AXSlider',
  'AXSwitch',
  'AXTab',
  'AXTextArea',
  'AXTextField',
])

interface ObservationTargetRecord {
  publicTarget: ComputerTarget
  nativeTarget: NativeObservedNode
  sourceIndex: number
}

type ComputerDriverReceipt = ComputerActionReceipt | ComputerVisualActionReceipt

interface ObservationRecord {
  id: string
  /** Per-observation random token embedded in every minted ref so an evicted
   * ref can be attributed to its observation through the bounded tombstone
   * set (see refObservationToken). */
  refToken: string
  fingerprint: string
  capturedAt: string
  expiresAtMs: number
  expiresAt: string
  native: NativeObserveResult
  targets: Map<string, ObservationTargetRecord>
  limits: { maxDepth: number; maxNodes: number }
  /** Serialized-payload byte estimate counted against the scope budget. */
  payloadBytes: number
}

/** v5 coordinate-based visual action binding, keyed by the delivered PNG SHA-256. */
interface CaptureBindingRecord {
  captureSha256: string
  observationId: string
  observationFingerprint: string
  app: ComputerObservation['app']
  window: ComputerCapturableWindowIdentity
  pointFrame: ComputerCapturableWindowIdentity['frame']
  pixelWidth: number
  pixelHeight: number
  scaleX: number
  scaleY: number
  capturedAt: string
  expiresAtMs: number
  /** SoM targets used to render the overlay, so a freshness re-capture re-renders an identical image. */
  targets: NativeCaptureTarget[]
  consumed: boolean
}

interface ScopeState {
  observations: Map<string, ObservationRecord>
  refs: Map<string, { observation: ObservationRecord; target: ObservationTargetRecord }>
  /** Live capture bindings keyed by capture SHA-256, each owned by one observation in this scope. */
  captures: Map<string, { observation: ObservationRecord; binding: CaptureBindingRecord }>
  receipts: ComputerDriverReceipt[]
  sequence: number
  receiptsDropped: number
  /** Running serialized-payload byte total of the retained observations. */
  payloadBytes: number
  /** Observation tokens whose refs were evicted by the memory bounds (not TTL/consumed). */
  evictedObservations: Set<string>
  busyObservations: Set<string>
}

export interface ComputerControllerOptions {
  native?: NativeTransport
  /** Test seam; production uses the verified native temporary-artifact wrapper. */
  capture?: typeof captureNativeWindow
  now?: () => number
  id?: () => string
  platform?: NodeJS.Platform
}

function integerInRange(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value)) throw new Error('numeric limits must be integers')
  return Math.max(minimum, Math.min(maximum, value))
}

// Reverse-DNS only: no path separators, URL schemes, spaces or shell syntax can
// reach the helper, which resolves the id through LaunchServices alone.
const BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/u

function validBundleId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !BUNDLE_ID_PATTERN.test(value) || !value.includes('.')) {
    throw new Error(`${label}: bundle id must be an exact reverse-DNS identifier such as com.apple.calculator`)
  }
  return value
}

function runningApp(value: unknown, label: string): ComputerRunningApp {
  const app = value as Partial<ComputerRunningApp> | null
  if (
    app === null || typeof app !== 'object'
    || typeof app.bundleId !== 'string' || !Number.isInteger(app.pid)
    || typeof app.active !== 'boolean' || !Array.isArray(app.windows)
    || !app.windows.every(window => window !== null && typeof window === 'object' && Number.isInteger(window.number))
  ) {
    throw new NativeHelperError('invalid_helper_response', `${label}: native helper returned a malformed application`)
  }
  return {
    bundleId: app.bundleId,
    pid: app.pid as number,
    launchIdentity: typeof app.launchIdentity === 'string' ? app.launchIdentity : null,
    name: typeof app.name === 'string' ? app.name : null,
    active: app.active,
    windows: app.windows.map(window => ({
      number: window.number,
      title: typeof window.title === 'string' ? window.title : null,
      frame: structuredClone(window.frame),
    })),
  }
}

function scopeId(context: ComputerDriverContext): string {
  if (typeof context.scopeId !== 'string' || context.scopeId.trim() === '' || context.scopeId.length > 256) {
    throw new Error('a non-empty host-derived scopeId of at most 256 characters is required')
  }
  return context.scopeId
}

function scopeLabel(scope: string): string {
  return createHash('sha256').update(scope).digest('hex').slice(0, 12)
}

/**
 * Refs are minted as cu_<observation-token>_<sourceIndex>; this parse
 * recovers the observation token from a ref that is no longer live, so the
 * bounded per-observation tombstone set can say OBSERVATION_EVICTED instead
 * of degrading to a plain unknown reference. Returns null for any ref that
 * is not in the minted shape.
 */
function refObservationToken(ref: string): string | null {
  if (!ref.startsWith('cu_')) return null
  const separator = ref.lastIndexOf('_')
  if (separator <= 3 || separator === ref.length - 1) return null
  const token = ref.slice(3, separator)
  const index = ref.slice(separator + 1)
  if (!/^\d{1,4}$/u.test(index)) return null
  if (!/^[A-Za-z0-9_-]{8,64}$/u.test(token)) return null
  return token
}

function markPriority(target: ObservationTargetRecord): number {
  const node = target.nativeTarget
  if (node.frame === null) return 2
  if (node.role === 'AXWindow' || node.role === 'AXApplication') return 1
  if (node.enabled !== false && (node.actions.length > 0 || INTERACTIVE_AX_ROLES.has(node.role))) return 0
  return 1
}

/**
 * Controller-side Set-of-Mark omission reason. A frameless INTERACTIVE target
 * (an action the driver could dispatch if only it had a frame) keeps the
 * native vocabulary's target_has_no_frame; genuinely non-interactive content
 * (static labels, window/application containers, disabled nodes) is
 * static-label. Native capture adds target_outside_captured_window and
 * stale_target: <detail> to the same closed vocabulary.
 */
function omittedTargetReason(
  target: ObservationTargetRecord,
): Extract<ComputerOmittedReason, 'target_has_no_frame' | 'static-label'> {
  const node = target.nativeTarget
  if (node.frame === null
    && node.enabled !== false
    && (node.actions.length > 0 || INTERACTIVE_AX_ROLES.has(node.role))) {
    return 'target_has_no_frame'
  }
  return 'static-label'
}

function emptyHelperStatus(
  platform: ComputerHelperStatus['platform'],
  detail: string,
): ComputerHelperStatus {
  return {
    platform,
    helper: 'unavailable',
    accessibilityTrusted: null,
    screenRecordingTrusted: null,
    sessionLocked: null,
    interactiveSessionAvailable: null,
    helperVersion: null,
    helperExecutable: null,
    bundle: null,
    signing: null,
    process: null,
    caller: null,
    resolution: null,
    identityStable: null,
    detail,
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]))
  }
  return value
}

function fingerprint(observation: NativeObserveResult): string {
  const identity = {
    app: observation.app,
    window: observation.window,
    nodes: observation.nodes
      .filter(node => node.actions.length > 0 || INTERACTIVE_AX_ROLES.has(node.role))
      .map(node => ({
      locator: node.locator,
      role: node.role,
      subrole: node.subrole,
      name: node.name,
      identifier: node.identifier,
      frame: node.frame,
      enabled: node.enabled,
      // Focus may legitimately move to the DSH approval UI while a human
      // decides. It is not part of the approval-stable observation identity.
      secure: node.secure,
      actions: node.actions,
      value: node.value,
      })),
  }
  return createHash('sha256').update(JSON.stringify(stableValue(identity))).digest('hex')
}

function publicTarget(ref: string, node: NativeObservedNode): ComputerTarget {
  return {
    ref,
    role: node.role,
    subrole: node.subrole,
    name: node.name,
    identifier: node.identifier,
    frame: node.frame === null ? null : { ...node.frame },
    enabled: node.enabled,
    focused: node.focused,
    secure: node.secure,
    actions: [...node.actions],
    value: node.secure ? null : node.value,
    depth: node.depth,
  }
}

function nativeElement(target: ComputerTarget): NativeElementIdentity {
  return {
    role: target.role,
    subrole: target.subrole,
    name: target.name,
    identifier: target.identifier,
    frame: target.frame === null ? null : { ...target.frame },
    enabled: target.enabled,
    focused: target.focused,
    secure: target.secure,
    actions: [...target.actions],
    value: target.secure ? null : target.value,
  }
}

function postAction(value: NativeActionResult['post']): ComputerPostActionObservation | null {
  if (value === null) return null
  return {
    capturedAt: value.capturedAt,
    app: structuredClone(value.app),
    window: structuredClone(value.window),
    target: value.target === null ? null : {
      role: value.target.role,
      subrole: value.target.subrole,
      name: value.target.name,
      identifier: value.target.identifier,
      frame: value.target.frame === null ? null : { ...value.target.frame },
      enabled: value.target.enabled,
      focused: value.target.focused,
      secure: value.target.secure,
      actions: [...value.target.actions],
      value: value.target.secure ? null : value.target.value,
    },
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Serialized-payload byte estimate of one retained native observation. The
 * scope budget bounds the retained payload text; it deliberately measures
 * JSON bytes, not a precise heap footprint, and is documented as such. */
function estimateObservationBytes(result: NativeObserveResult): number {
  return Buffer.byteLength(JSON.stringify(result), 'utf8')
}

function nativeAction(action: ComputerAction): NativeActionPayload {
  switch (action.kind) {
    case 'click': return { kind: 'click' }
    case 'focus': return { kind: 'focus' }
    case 'type': return { kind: 'type', text: action.text }
    case 'key': return { kind: 'key', key: normalizeKeyName(action.key), modifiers: normalizeModifiers(action.modifiers) }
    case 'scroll': return { kind: 'scroll', direction: action.direction, amount: action.amount ?? 'page' }
  }
}

/** Capture every caller-owned field before the first await and sever array aliases. */
function immutableActionSnapshot(input: ComputerAction): ComputerAction {
  let snapshot: ComputerAction
  switch (input.kind) {
    case 'click': snapshot = { kind: 'click', ref: input.ref }; break
    case 'focus': snapshot = { kind: 'focus', ref: input.ref }; break
    case 'type': snapshot = { kind: 'type', ref: input.ref, text: input.text }; break
    case 'key': {
      const modifiers = normalizeModifiers(input.modifiers === undefined ? undefined : [...input.modifiers])
      Object.freeze(modifiers)
      snapshot = { kind: 'key', ref: input.ref, key: normalizeKeyName(input.key), modifiers }
      break
    }
    case 'scroll': {
      snapshot = input.amount === undefined
        ? { kind: 'scroll', ref: input.ref, direction: input.direction }
        : { kind: 'scroll', ref: input.ref, direction: input.direction, amount: input.amount }
      break
    }
  }
  Object.freeze(snapshot)
  return snapshot
}

/**
 * v1 canonical bytes: each UTF-8 component is `<byteLength>:<value>`, joined
 * by `|`. Components are version, kind, then exact type text OR normalized key
 * followed by unique lexically-sorted modifiers. Ref is bound separately.
 */
function normalizedActionDigest(action: ComputerAction): string {
  const components = ['dsh-computer-action-v1', action.kind]
  if (action.kind === 'type') components.push(action.text)
  if (action.kind === 'key') components.push(action.key, ...(action.modifiers ?? []))
  const canonical = components.map(value => `${Buffer.byteLength(value, 'utf8')}:${value}`).join('|')
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/** Native-image pixel -> global top-left point through the bound capture geometry. */
function nativePointToGlobal(
  binding: Pick<CaptureBindingRecord, 'pointFrame' | 'scaleX' | 'scaleY'>,
  point: ComputerPoint,
): { x: number; y: number } {
  return {
    x: binding.pointFrame.x + point.x / binding.scaleX,
    y: binding.pointFrame.y + point.y / binding.scaleY,
  }
}

/** A secure AX node whose frame contains the global point: the point path must never bypass it. */
function secureNodeUnderPoint(
  nodes: readonly NativeObservedNode[],
  point: { x: number; y: number },
): NativeObservedNode | null {
  for (const node of nodes) {
    if (!node.secure || node.frame === null) continue
    if (point.x >= node.frame.x && point.x <= node.frame.x + node.frame.width
      && point.y >= node.frame.y && point.y <= node.frame.y + node.frame.height) {
      return node
    }
  }
  return null
}

/** Human-safe rejection reason when the visual start or a drag endpoint is over a secure field. */
function visualSecurePointError(
  action: ComputerVisualAction,
  binding: CaptureBindingRecord,
  nodes: readonly NativeObservedNode[],
): string | null {
  const points = action.op === 'drag'
    ? [
        ['point', action.point],
        ['drag endpoint', action.to],
      ] as const
    : [['point', action.point]] as const
  for (const [label, point] of points) {
    if (secureNodeUnderPoint(nodes, nativePointToGlobal(binding, point)) !== null) {
      return `${label} falls on a secure text field; the visual point path cannot bypass an Accessibility security rejection`
    }
  }
  return null
}

function visualScrollAmountCanonical(amount: ComputerScrollAmount | undefined): string {
  if (amount === undefined || amount === 'page') return 'page'
  if (amount === 'line') return 'line'
  return amount.toFixed(2)
}

/**
 * Cross-language canonical digest for v5 visual actions. Computed over the
 * integer native pixel coordinates and the exact capture/window identity so no
 * float rounding can ever change an approved action. Must stay in lockstep with
 * Swift's VisualActionApprovalBinding.digest.
 */
function normalizedVisualActionDigest(
  action: ComputerVisualAction,
  binding: CaptureBindingRecord,
): string {
  const components = [
    'dsh-computer-visual-action-v1',
    action.op,
    action.captureSha256,
    String(action.point.x),
    String(action.point.y),
  ]
  if (action.op === 'drag') components.push(String(action.to.x), String(action.to.y))
  if (action.op === 'scroll') {
    components.push(action.direction, visualScrollAmountCanonical(action.amount))
  }
  components.push(String(binding.window.number), binding.window.identity)
  const canonical = components.map(value => Buffer.byteLength(value, 'utf8') + ':' + value).join('|')
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

function readPixelPoint(value: unknown, label: string): ComputerPoint {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a pixel object with integer x and y`)
  }
  const record = value as Record<string, unknown>
  if (typeof record.x !== 'number' || typeof record.y !== 'number'
      || !Number.isFinite(record.x) || !Number.isFinite(record.y)) {
    throw new Error(`${label} must carry finite numeric x and y`)
  }
  return { x: record.x, y: record.y }
}

/** Snapshot a visual action before the first await and sever array/object aliases. */
function immutableVisualActionSnapshot(input: ComputerVisualAction): ComputerVisualAction {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('visual action must be an object')
  }
  if (input.kind !== 'point') throw new Error('visual action kind must be point')
  const op = input.op
  if (op !== 'click' && op !== 'drag' && op !== 'scroll') {
    throw new Error('visual action op must be click, drag, or scroll')
  }
  if (typeof input.observationId !== 'string' || input.observationId.trim() === '') {
    throw new Error('visual action requires a non-empty observationId')
  }
  if (typeof input.captureSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(input.captureSha256)) {
    throw new Error('captureSha256 must be the exact 64-hex digest from computer_visual_observe')
  }
  const point = readPixelPoint(input.point, 'point')
  let snapshot: ComputerVisualAction
  switch (op) {
    case 'click': {
      snapshot = { kind: 'point', op: 'click', observationId: input.observationId, captureSha256: input.captureSha256, point }
      break
    }
    case 'drag': {
      snapshot = { kind: 'point', op: 'drag', observationId: input.observationId, captureSha256: input.captureSha256, point, to: readPixelPoint(input.to, 'drag endpoint') }
      break
    }
    case 'scroll': {
      if (input.direction !== 'up' && input.direction !== 'down') {
        throw new Error('visual scroll requires direction up or down')
      }
      const amount = input.amount
      if (amount !== undefined && amount !== 'line' && amount !== 'page'
        && (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0)) {
        throw new Error('visual scroll amount must be line, page, or a positive number')
      }
      snapshot = amount === undefined
        ? { kind: 'point', op: 'scroll', observationId: input.observationId, captureSha256: input.captureSha256, point, direction: input.direction }
        : { kind: 'point', op: 'scroll', observationId: input.observationId, captureSha256: input.captureSha256, point, direction: input.direction, amount }
      break
    }
  }
  Object.freeze(snapshot)
  Object.freeze(snapshot.point)
  if (snapshot.op === 'drag') Object.freeze(snapshot.to)
  return snapshot
}

function nativeVisualAction(action: ComputerVisualAction): NativeVisualActionPayload {
  switch (action.op) {
    case 'click': return { op: 'click', point: { x: action.point.x, y: action.point.y } }
    case 'drag': return { op: 'drag', point: { x: action.point.x, y: action.point.y }, to: { x: action.to.x, y: action.to.y } }
    case 'scroll': return { op: 'scroll', point: { x: action.point.x, y: action.point.y }, direction: action.direction, amount: action.amount ?? 'page' }
  }
}

function nativePixelPointError(
  point: ComputerPoint,
  binding: CaptureBindingRecord,
  label: string,
): string | null {
  if (typeof point !== 'object' || point === null
      || !Number.isSafeInteger(point.x) || !Number.isSafeInteger(point.y)) {
    return label + ' must carry integer native-image pixel coordinates'
  }
  if (point.x < 0 || point.y < 0 || point.x >= binding.pixelWidth || point.y >= binding.pixelHeight) {
    return label + ' is outside the captured window bounds'
  }
  return null
}

function visualActionShapeError(action: ComputerVisualAction, binding: CaptureBindingRecord): string | null {
  const pointError = nativePixelPointError(action.point, binding, 'point')
  if (pointError !== null) return pointError
  if (action.op === 'drag') {
    const toError = nativePixelPointError(action.to, binding, 'drag endpoint')
    if (toError !== null) return toError
  }
  if (action.op === 'scroll') {
    if (action.direction !== 'up' && action.direction !== 'down') {
      return 'scroll requires direction up or down'
    }
    const amount = action.amount
    if (amount !== undefined && amount !== 'line' && amount !== 'page'
      && (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0)) {
      return 'scroll amount must be line, page, or a positive number of points'
    }
  }
  return null
}

function informedVisualApprovalReason(
  action: ComputerVisualAction,
  observation: ObservationRecord,
  binding: CaptureBindingRecord,
): string {
  const global = nativePointToGlobal(binding, action.point)
  const app = approvalField(observation.native.app.bundleId, 32, 'unknown')
  const title = approvalField(observation.native.window.title, 24, 'untitled')
  const number = observation.native.window.number === null ? '?' : String(observation.native.window.number)
  let detail: string
  if (action.op === 'drag') {
    const to = nativePointToGlobal(binding, action.to)
    detail = 'op=drag from=(' + global.x.toFixed(1) + ',' + global.y.toFixed(1) + ') to=(' + to.x.toFixed(1) + ',' + to.y.toFixed(1) + ')'
  } else if (action.op === 'scroll') {
    detail = 'op=scroll at=(' + global.x.toFixed(1) + ',' + global.y.toFixed(1) + ') direction=' + action.direction + ' amount=' + String(action.amount ?? 'page')
  } else {
    detail = 'op=click at=(' + global.x.toFixed(1) + ',' + global.y.toFixed(1) + ')'
  }
  return singleLine(
    'Approve once: visual ' + detail + '; app=' + app + '; window=#' + number + " title='" + title + "'; "
      + 'capture=' + binding.captureSha256.slice(0, 12) + '…',
  )
}

function visualApprovalDenialReason(outcome: 'rejected' | 'cancelled' | 'unavailable'): string {
  const prefix = outcome === 'rejected'
    ? 'the user rejected this visual action'
    : outcome === 'cancelled'
      ? 'approval for this visual action was cancelled'
      : 'host approval is unavailable'
  return prefix + '; action was not dispatched'
}

function frameMatches(
  expected: { x: number; y: number; width: number; height: number } | null,
  live: { x: number; y: number; width: number; height: number } | null,
): boolean {
  if (expected === null || live === null) return expected === live
  return Math.abs(expected.x - live.x) <= 1
    && Math.abs(expected.y - live.y) <= 1
    && Math.abs(expected.width - live.width) <= 1
    && Math.abs(expected.height - live.height) <= 1
}

/**
 * Field-specific "what changed" reasons mirroring the native IdentityVerifier
 * vocabulary, so a failed re-verification can name the exact change instead of
 * collapsing everything into a fingerprint mismatch. Values are never embedded,
 * so no window title or field content can leak.
 */
function appChangedReason(expected: NativeObserveResult['app'], live: NativeObserveResult['app']): string | null {
  if (expected.bundleId !== live.bundleId) return 'application bundle identifier changed'
  if (expected.pid !== live.pid) return 'application PID changed'
  if (expected.launchIdentity === null || expected.launchIdentity !== live.launchIdentity) {
    return 'application launch identity is missing or changed'
  }
  return null
}

function windowChangedReason(expected: NativeObserveResult['window'], live: NativeObserveResult['window']): string | null {
  if (expected.number !== null) {
    if (live.number !== expected.number) return 'window number changed'
  } else if (live.identity !== expected.identity) {
    return 'window identity changed'
  }
  if (expected.role !== live.role || expected.subrole !== live.subrole) return 'window role changed'
  if (expected.title !== live.title) return 'window title changed'
  if (expected.frame === null) {
    if (live.frame !== null) return 'window frame appeared'
  } else if (!frameMatches(expected.frame, live.frame)) {
    return 'window frame changed'
  }
  return null
}

function elementChangedReason(expected: NativeObservedNode, live: NativeObservedNode): string | null {
  if (expected.role !== live.role || expected.subrole !== live.subrole) return 'target role changed'
  if (expected.identifier !== live.identifier) return 'target identifier changed'
  if (expected.name !== live.name) return 'target name changed'
  if (expected.frame === null) {
    if (live.frame !== null) return 'target frame appeared'
  } else if (!frameMatches(expected.frame, live.frame)) {
    return 'target frame changed'
  }
  if (expected.secure !== live.secure) return 'target security role changed'
  return null
}

function locatorMatches(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function singleLine(value: string, maximum = 240): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, Math.max(0, maximum - 1))}…`
}

function approvalField(value: string | null, maximum: number, fallback: string): string {
  if (value === null) return fallback
  const normalized = value.normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/['";=|]/gu, '_')
    .trim()
  if (normalized === '') return fallback
  const characters = [...normalized]
  return characters.length <= maximum ? normalized : `${characters.slice(0, Math.max(0, maximum - 1)).join('')}…`
}

function informedApprovalReason(
  action: ComputerAction,
  risk: Extract<ComputerActionRisk, { kind: 'approval-required' }>,
  observation: ObservationRecord,
  target: NativeObservedNode,
): string {
  const actionDetail = action.kind === 'key'
    ? `action=key chord=${approvalField([...(action.modifiers ?? []), action.key].join('+'), 38, 'unknown')}`
    : `action=${action.kind}`
  const app = approvalField(observation.native.app.bundleId, 32, 'unknown')
  const title = approvalField(observation.native.window.title, 24, 'untitled')
  const number = observation.native.window.number === null ? '?' : String(observation.native.window.number)
  const role = approvalField(target.role, 18, 'unknown')
  const name = approvalField(target.name, 24, 'unnamed')
  const identifier = approvalField(target.identifier, 24, 'none')
  return singleLine(
    `Approve once: ${actionDetail} category=${risk.category}; app=${app}; `
      + `window=#${number} title='${title}'; target=${role} name='${name}' id='${identifier}'.`,
  )
}

class LivePreflightError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LivePreflightError'
  }
}

function readinessError(action: ComputerAction, target: NativeObservedNode): string | null {
  if (target.enabled === false) return 'live target is disabled; run computer_observe again'
  if (action.kind === 'click' && !target.actions.includes('AXPress')) {
    return 'live target no longer exposes AXPress; run computer_observe again'
  }
  return null
}

function approvalDenialReason(outcome: 'rejected' | 'cancelled' | 'unavailable', risk: ComputerActionRisk): string {
  const prefix = outcome === 'rejected'
    ? 'the user rejected this action'
    : outcome === 'cancelled'
      ? 'approval for this action was cancelled'
      : 'host approval is unavailable'
  return `${prefix}; ${risk.kind === 'approval-required' ? risk.reason : 'action was not dispatched'}`
}

function confirmedByPost(
  action: ComputerAction,
  expected: ObservationTargetRecord,
  observation: ObservationRecord,
  result: NativeActionResult,
): boolean {
  const post = result.post
  const target = post?.target
  if (!post || !target) return false
  if (post.app.bundleId !== observation.native.app.bundleId
    || post.app.pid !== observation.native.app.pid
    || post.app.launchIdentity === null
    || post.app.launchIdentity !== observation.native.app.launchIdentity) return false
  const expectedWindow = observation.native.window
  if ((expectedWindow.number !== null
    ? post.window.number !== expectedWindow.number
    : post.window.identity !== expectedWindow.identity)
    || post.window.role !== expectedWindow.role
    || post.window.subrole !== expectedWindow.subrole
    || post.window.title !== expectedWindow.title
    || !frameMatches(expectedWindow.frame, post.window.frame)) return false
  const before = expected.publicTarget
  if (target.role !== before.role || target.subrole !== before.subrole
    || target.name !== before.name || target.identifier !== before.identifier
    || target.secure !== before.secure || !frameMatches(before.frame, target.frame)) return false

  if (action.kind === 'focus') return target.focused === true
  if (action.kind === 'type') return target.value === action.text
  if (action.kind === 'click') return target.value !== before.value
  return false
}

class WindowLockCancelledError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WindowLockCancelledError'
  }
}

interface WindowLockWaiter {
  readonly scope: string
  readonly signal: AbortSignal | undefined
  readonly resolve: (release: () => void) => void
  readonly reject: (error: WindowLockCancelledError) => void
  abortListener?: () => void
}

interface WindowLockEntry {
  locked: boolean
  readonly waiters: WindowLockWaiter[]
}

/** FIFO keyed mutex with independently cancellable Agent waiters. */
class WindowMutex {
  readonly #entries = new Map<string, WindowLockEntry>()
  #disposed = false

  acquire(key: string, scope: string, signal?: AbortSignal): Promise<() => void> {
    if (this.#disposed) return Promise.reject(new WindowLockCancelledError('computer driver was disposed while waiting for the window lock'))
    if (signal?.aborted) return Promise.reject(new WindowLockCancelledError('window operation was cancelled before dispatch'))
    let entry = this.#entries.get(key)
    if (entry === undefined) {
      entry = { locked: false, waiters: [] }
      this.#entries.set(key, entry)
    }
    if (!entry.locked) {
      entry.locked = true
      return Promise.resolve(this.#releaseOnce(key, entry))
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: WindowLockWaiter = { scope, signal, resolve, reject }
      if (signal !== undefined) {
        waiter.abortListener = () => {
          const index = entry.waiters.indexOf(waiter)
          if (index !== -1) entry.waiters.splice(index, 1)
          reject(new WindowLockCancelledError('window operation was cancelled before dispatch'))
        }
        signal.addEventListener('abort', waiter.abortListener, { once: true })
      }
      entry.waiters.push(waiter)
    })
  }

  cancelScope(scope: string): void {
    for (const entry of this.#entries.values()) {
      for (let index = entry.waiters.length - 1; index >= 0; index -= 1) {
        const waiter = entry.waiters[index]
        if (waiter?.scope !== scope) continue
        entry.waiters.splice(index, 1)
        if (waiter.abortListener !== undefined) waiter.signal?.removeEventListener('abort', waiter.abortListener)
        waiter.reject(new WindowLockCancelledError('Agent scope was disposed while waiting for the window lock'))
      }
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const entry of this.#entries.values()) {
      for (const waiter of entry.waiters.splice(0)) {
        if (waiter.abortListener !== undefined) waiter.signal?.removeEventListener('abort', waiter.abortListener)
        waiter.reject(new WindowLockCancelledError('computer driver was disposed while waiting for the window lock'))
      }
    }
  }

  #releaseOnce(key: string, entry: WindowLockEntry): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.#release(key, entry)
    }
  }

  #release(key: string, entry: WindowLockEntry): void {
    while (entry.waiters.length > 0) {
      const waiter = entry.waiters.shift()
      if (waiter === undefined) break
      if (waiter.abortListener !== undefined) waiter.signal?.removeEventListener('abort', waiter.abortListener)
      if (waiter.signal?.aborted) {
        waiter.reject(new WindowLockCancelledError('window operation was cancelled before dispatch'))
        continue
      }
      waiter.resolve(this.#releaseOnce(key, entry))
      return
    }
    entry.locked = false
    if (this.#entries.get(key) === entry) this.#entries.delete(key)
  }
}

function windowLockKey(observation: ObservationRecord): string {
  // AX focus and keyboard dispatch are process-global enough that two windows
  // in one app can still interfere. Serialize the whole live app launch;
  // different app launches remain independent.
  return createHash('sha256')
    .update(observation.native.app.launchIdentity
      ?? `missing-launch-identity\u0000${observation.native.app.bundleId}\u0000${observation.native.app.pid}`)
    .digest('hex')
}

function preflightReceiptStatus(error: unknown): 'rejected' | 'failed' {
  if (error instanceof LivePreflightError) return 'rejected'
  if (error instanceof NativeHelperError
    && (error.code === 'session_locked' || error.code === 'accessibility_permission_required')) return 'rejected'
  return 'failed'
}

/** Runtime implementation shared by DSH tools and the Cordis driver service. */
export class ComputerController implements ComputerDriver {
  readonly kind = 'computer' as const
  readonly platform = 'macos' as const
  readonly contractVersion = COMPUTER_DRIVER_CONTRACT_VERSION
  readonly #native: NativeTransport
  readonly #capture: typeof captureNativeWindow
  readonly #now: () => number
  readonly #id: () => string
  readonly #hostPlatform: NodeJS.Platform
  readonly #scopes = new Map<string, ScopeState>()
  readonly #scopeGenerations = new Map<string, number>()
  readonly #windowMutex = new WindowMutex()
  #disposed = false

  constructor(options: ComputerControllerOptions = {}) {
    this.#native = options.native ?? new NativeHelper()
    this.#capture = options.capture ?? captureNativeWindow
    this.#now = options.now ?? Date.now
    this.#id = options.id ?? randomUUID
    this.#hostPlatform = options.platform ?? process.platform
  }

  #state(scope: string): ScopeState {
    const existing = this.#scopes.get(scope)
    if (existing) return existing
    const created: ScopeState = {
      observations: new Map(), refs: new Map(), captures: new Map(), receipts: [], sequence: 0,
      receiptsDropped: 0, evictedObservations: new Set(), busyObservations: new Set(),
      payloadBytes: 0,
    }
    this.#scopes.set(scope, created)
    return created
  }

  #scopeGeneration(scope: string): number {
    return this.#scopeGenerations.get(scope) ?? 0
  }

  #dropObservation(state: ScopeState, observation: ObservationRecord): void {
    const removed = state.observations.delete(observation.id)
    for (const ref of observation.targets.keys()) state.refs.delete(ref)
    for (const [sha256, entry] of state.captures) {
      if (entry.observation === observation) state.captures.delete(sha256)
    }
    if (removed) {
      state.payloadBytes = Math.max(0, state.payloadBytes - observation.payloadBytes)
    }
  }

  /** Memory eviction: one tombstone per observation, so a later act on any
   * of its refs can still report OBSERVATION_EVICTED instead of a false
   * unknown reference. */
  #evictObservation(state: ScopeState, observation: ObservationRecord): void {
    state.evictedObservations.add(observation.refToken)
    this.#dropObservation(state, observation)
    while (state.evictedObservations.size > MAX_EVICTED_OBSERVATIONS) {
      const oldest = state.evictedObservations.values().next().value
      if (oldest === undefined) break
      state.evictedObservations.delete(oldest)
    }
  }

  #cleanExpired(state: ScopeState): void {
    const now = this.#now()
    for (const observation of state.observations.values()) {
      if (observation.expiresAtMs <= now) this.#dropObservation(state, observation)
    }
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error('dsh-computer driver is disposed')
    if (this.#hostPlatform !== 'darwin') throw new ComputerPlatformError(this.#hostPlatform)
  }

  async observe(request: ComputerObserveRequest, context: ComputerDriverContext): Promise<ComputerObservation> {
    const requestSnapshot = structuredClone(request)
    this.#assertLive()
    const scope = scopeId(context)
    const scopeGeneration = this.#scopeGeneration(scope)
    const maxDepth = integerInRange(requestSnapshot.maxDepth, DEFAULT_MAX_DEPTH, 1, 8)
    const maxNodes = integerInRange(requestSnapshot.maxNodes, DEFAULT_MAX_NODES, 1, 500)
    const ttlMs = integerInRange(requestSnapshot.ttlMs, DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS)
    const nativeResult = await this.#native.request<NativeObserveResult>({
      id: this.#id(),
      command: 'observe',
      app: requestSnapshot.app ?? null,
      window: requestSnapshot.window ?? null,
      maxDepth,
      maxNodes,
    }, {
      scopeId: scope,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    })
    const result = structuredClone(nativeResult)

    if (this.#disposed || this.#scopeGeneration(scope) !== scopeGeneration) {
      throw new Error('Agent scope was disposed while computer_observe was running')
    }

    const state = this.#state(scope)
    this.#cleanExpired(state)
    while (state.observations.size >= MAX_OBSERVATIONS_PER_SCOPE) {
      const oldest = state.observations.values().next().value as ObservationRecord | undefined
      if (!oldest) break
      this.#evictObservation(state, oldest)
    }

    const payloadBytes = estimateObservationBytes(result)
    // Byte-budget eviction: the oldest TTL-valid observations go first, so a
    // large retained history can never grow the controller unboundedly. The
    // observation being inserted is never evicted here — if it alone exceeds
    // the budget it is retained anyway (the ceiling bounds aggregate growth,
    // not a single result).
    while (state.payloadBytes + payloadBytes > MAX_OBSERVATION_BYTES_PER_SCOPE
      && state.observations.size > 0) {
      const oldest = state.observations.values().next().value as ObservationRecord | undefined
      if (!oldest) break
      this.#evictObservation(state, oldest)
    }
    state.payloadBytes += payloadBytes

    const observedAtMs = this.#now()
    const id = `obs_${this.#id()}`
    const expiresAtMs = observedAtMs + ttlMs
    const record: ObservationRecord = {
      id,
      refToken: randomBytes(12).toString('base64url'),
      fingerprint: fingerprint(result),
      capturedAt: result.capturedAt,
      expiresAtMs,
      expiresAt: new Date(expiresAtMs).toISOString(),
      native: result,
      targets: new Map(),
      limits: { maxDepth, maxNodes },
      payloadBytes,
    }
    for (const [sourceIndex, node] of result.nodes.entries()) {
      // Refs carry their observation token (cu_<token>_<index>) so the
      // bounded per-observation tombstone set can attribute an evicted ref
      // back to its observation without storing one tombstone per ref. The
      // 96-bit token keeps every ref unguessable; live refs resolve through
      // state.refs, the token is only parsed for absent refs.
      const ref = `cu_${record.refToken}_${sourceIndex}`
      const target: ObservationTargetRecord = { publicTarget: publicTarget(ref, node), nativeTarget: node, sourceIndex }
      record.targets.set(ref, target)
      state.refs.set(ref, { observation: record, target })
    }
    state.observations.set(id, record)

    return structuredClone({
      observationId: id,
      fingerprint: record.fingerprint,
      capturedAt: record.capturedAt,
      expiresAt: record.expiresAt,
      app: result.app,
      window: result.window,
      targets: [...record.targets.values()].map(target => target.publicTarget),
      truncated: result.truncated,
      limits: { maxDepth, maxNodes, ttlMs },
    })
  }

  async visualObserve(
    request: ComputerVisualObserveRequest,
    context: ComputerDriverContext,
  ): Promise<ComputerVisualCapture> {
    this.#assertLive()
    const scope = scopeId(context)
    if (typeof request.observationId !== 'string' || request.observationId.trim() === '') {
      throw new Error('computer_visual_observe requires a non-empty observationId')
    }
    const maxMarks = integerInRange(request.maxMarks, DEFAULT_MAX_MARKS, 1, MAX_MARKS)
    const state = this.#scopes.get(scope)
    if (state === undefined) {
      throw new Error('unknown observation in this Agent scope; run computer_observe first')
    }
    this.#cleanExpired(state)
    const observation = state.observations.get(request.observationId)
    if (observation === undefined) {
      throw new Error('unknown or expired observation in this Agent scope; run computer_observe again')
    }
    if (observation.expiresAtMs <= this.#now()) {
      this.#dropObservation(state, observation)
      throw new Error('stale observation; run computer_observe again')
    }
    const observedWindow = observation.native.window
    if (observedWindow.number === null || observedWindow.frame === null) {
      throw new Error('computer_visual_observe requires an observation with an exact window number and frame')
    }
    if (state.busyObservations.has(observation.id)) {
      throw new Error('another operation is already using this observation')
    }

    state.busyObservations.add(observation.id)
    const scopeGeneration = this.#scopeGeneration(scope)
    const bindingFailure = (): string | null => {
      if (this.#disposed || this.#scopeGeneration(scope) !== scopeGeneration || this.#scopes.get(scope) !== state) {
        return 'Agent scope was disposed while computer_visual_observe was running'
      }
      if (state.observations.get(observation.id) !== observation) {
        return 'observation changed while computer_visual_observe was running; run computer_observe again'
      }
      if (observation.expiresAtMs <= this.#now()) {
        this.#dropObservation(state, observation)
        return 'observation expired while computer_visual_observe was running; run computer_observe again'
      }
      return null
    }

    let releaseWindow: (() => void) | undefined
    try {
      releaseWindow = await this.#windowMutex.acquire(windowLockKey(observation), scope, context.signal)
      const beforeCapture = bindingFailure()
      if (beforeCapture !== null) throw new Error(beforeCapture)
      const allTargets = [...observation.targets.values()]
      // SoM is an action map, not an Accessibility debug overlay. Static
      // labels remain visible in the screenshot/AX JSON but do not receive
      // opaque action numbers that the driver could never safely dispatch.
      const markable = allTargets
        .filter(target => target.nativeTarget.frame !== null && markPriority(target) === 0)
        .sort((left, right) => markPriority(left) - markPriority(right) || left.sourceIndex - right.sourceIndex)
      const selected = markable.slice(0, maxMarks)
      const beyondBudget = markable.slice(maxMarks)
      const omittedTargets = allTargets.filter(
        target => !(target.nativeTarget.frame !== null && markPriority(target) === 0),
      )
      const targets = selected.map(target => ({
        ref: target.publicTarget.ref,
        index: target.sourceIndex,
        element: nativeElement(target.publicTarget),
        locator: [...target.nativeTarget.locator],
      }))
      const captured = await this.#capture(this.#native, {
        id: this.#id(),
        capture: {
          app: structuredClone(observation.native.app),
          window: structuredClone({ ...observedWindow, number: observedWindow.number, frame: observedWindow.frame }),
          targets,
        },
      }, {
        scopeId: scope,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      })
      const afterCapture = bindingFailure()
      if (afterCapture !== null) throw new Error(afterCapture)

      // Persist the capture binding so a later computer_visual_act can resolve
      // native-image pixels through the exact, verified capture geometry. The
      // binding is keyed by the delivered PNG SHA-256 and owns one observation.
      const binding: CaptureBindingRecord = {
        captureSha256: captured.result.artifact.sha256,
        observationId: observation.id,
        observationFingerprint: observation.fingerprint,
        app: structuredClone(captured.result.app),
        window: structuredClone(captured.result.window),
        pointFrame: structuredClone(captured.result.pointFrame),
        pixelWidth: captured.result.pixelWidth,
        pixelHeight: captured.result.pixelHeight,
        scaleX: captured.result.scaleX,
        scaleY: captured.result.scaleY,
        capturedAt: captured.result.capturedAt,
        expiresAtMs: observation.expiresAtMs,
        targets: targets.map(target => structuredClone(target)),
        consumed: false,
      }
      state.captures.set(binding.captureSha256, { observation, binding })

      return {
        observationId: observation.id,
        observationFingerprint: observation.fingerprint,
        capturedAt: captured.result.capturedAt,
        expiresAt: observation.expiresAt,
        app: structuredClone(captured.result.app),
        window: structuredClone(captured.result.window),
        png: Buffer.from(captured.png),
        capture: {
          artifact: { ...captured.result.artifact },
          pointFrame: { ...captured.result.pointFrame },
          pixelWidth: captured.result.pixelWidth,
          pixelHeight: captured.result.pixelHeight,
          scaleX: captured.result.scaleX,
          scaleY: captured.result.scaleY,
          quality: { ...captured.result.quality },
        },
        marks: captured.result.marks.map(mark => ({
          number: mark.number,
          ref: mark.ref,
          sourceIndex: mark.index,
          nativePixelFrame: { ...mark.pixelFrame },
        })),
        omitted: [
          ...captured.result.omitted.map(omission => ({
            ref: omission.ref,
            sourceIndex: omission.index,
            reason: omission.reason,
          })),
          ...beyondBudget.map(target => ({
            ref: target.publicTarget.ref,
            sourceIndex: target.sourceIndex,
            reason: 'mark-budget-exceeded',
          })),
          ...omittedTargets.map(target => ({
            ref: target.publicTarget.ref,
            sourceIndex: target.sourceIndex,
            reason: omittedTargetReason(target),
          })),
        ],
      }
    } finally {
      releaseWindow?.()
      state.busyObservations.delete(observation.id)
    }
  }

  /** Read-only AX re-observation used before asking and immediately before dispatch. */
  async #preflight(
    scope: string,
    observation: ObservationRecord,
    target: ObservationTargetRecord,
    signal: AbortSignal | undefined,
  ): Promise<NativeObservedNode> {
    const expectedWindow = observation.native.window
    const app = observation.native.app
    const nativeResult = await this.#native.request<NativeObserveResult>({
      id: this.#id(),
      command: 'observe',
      app: { bundleId: app.bundleId, pid: app.pid },
      window: expectedWindow.number === null && expectedWindow.title === null
        ? null
        : {
            ...(expectedWindow.number === null ? {} : { number: expectedWindow.number }),
            ...(expectedWindow.title === null ? {} : { title: expectedWindow.title }),
          },
      maxDepth: observation.limits.maxDepth,
      maxNodes: observation.limits.maxNodes,
    }, {
      scopeId: scope,
      ...(signal === undefined ? {} : { signal }),
    })
    const result = structuredClone(nativeResult)
    const appReason = appChangedReason(observation.native.app, result.app)
    if (appReason !== null) {
      throw new LivePreflightError(`live application identity changed: ${appReason}; run computer_observe again`)
    }
    const windowReason = windowChangedReason(observation.native.window, result.window)
    if (windowReason !== null) {
      throw new LivePreflightError(`live window identity changed: ${windowReason}; run computer_observe again`)
    }
    // Re-verify the specific target before the whole-observation fingerprint so
    // a target move/rename/disappearance names the target, while other observed
    // element changes still surface as a fingerprint mismatch.
    const live = result.nodes.find(node => locatorMatches(node.locator, target.nativeTarget.locator))
    if (!live) {
      throw new LivePreflightError('live target identity changed: target disappeared; run computer_observe again')
    }
    const elementReason = elementChangedReason(target.nativeTarget, live)
    if (elementReason !== null) {
      throw new LivePreflightError(`live target identity changed: ${elementReason}; run computer_observe again`)
    }
    if (fingerprint(result) !== observation.fingerprint) {
      throw new LivePreflightError('live observation fingerprint changed; run computer_observe again')
    }
    return live
  }

  /** Read-only app+window re-observation used before asking and immediately before a visual dispatch. */
  async #preflightWindow(
    scope: string,
    observation: ObservationRecord,
    signal: AbortSignal | undefined,
  ): Promise<NativeObserveResult> {
    const expectedWindow = observation.native.window
    const app = observation.native.app
    const nativeResult = await this.#native.request<NativeObserveResult>({
      id: this.#id(),
      command: 'observe',
      app: { bundleId: app.bundleId, pid: app.pid },
      // Visual captures always have an explicit window number; bind by it so a
      // title-only match can never resolve the wrong same-titled window.
      window: expectedWindow.number === null ? {} : { number: expectedWindow.number },
      maxDepth: observation.limits.maxDepth,
      maxNodes: observation.limits.maxNodes,
    }, {
      scopeId: scope,
      ...(signal === undefined ? {} : { signal }),
    })
    const result = structuredClone(nativeResult)
    const appReason = appChangedReason(observation.native.app, result.app)
    if (appReason !== null) {
      throw new LivePreflightError(`live application identity changed: ${appReason}; run computer_observe again`)
    }
    const windowReason = windowChangedReason(observation.native.window, result.window)
    if (windowReason !== null) {
      throw new LivePreflightError(`live window identity changed: ${windowReason}; run computer_observe again`)
    }
    return result
  }

  #receipt(
    state: ScopeState,
    input: {
      status: ComputerActionStatus
      action: ComputerAction
      observation: ObservationRecord | null
      startedAt: string
      reason: string
      nativeAccepted: boolean
      postAction: ComputerPostActionObservation | null
    },
  ): ComputerActionReceipt {
    const receipt: ComputerActionReceipt = {
      receiptId: `receipt_${this.#id()}`,
      sequence: ++state.sequence,
      status: input.status,
      action: input.action.kind,
      ref: input.action.ref,
      observationId: input.observation?.id ?? null,
      observationFingerprint: input.observation?.fingerprint ?? null,
      startedAt: input.startedAt,
      finishedAt: new Date(this.#now()).toISOString(),
      reason: input.reason,
      nativeAccepted: input.nativeAccepted,
      postAction: input.postAction,
    }
    const storedReceipt = structuredClone(receipt)
    state.receipts.push(storedReceipt)
    if (state.receipts.length > MAX_RECEIPTS_PER_SCOPE) {
      state.receiptsDropped += state.receipts.length - MAX_RECEIPTS_PER_SCOPE
      state.receipts.splice(0, state.receipts.length - MAX_RECEIPTS_PER_SCOPE)
    }
    return structuredClone(storedReceipt)
  }

  #visualReceipt(
    state: ScopeState,
    input: {
      status: ComputerActionStatus
      action: ComputerVisualAction | null
      observation: ObservationRecord | null
      startedAt: string
      reason: string
      nativeAccepted: boolean
      postAction: ComputerPostActionObservation | null
    },
  ): ComputerVisualActionReceipt {
    const receipt: ComputerVisualActionReceipt = {
      receiptId: `receipt_${this.#id()}`,
      sequence: ++state.sequence,
      status: input.status,
      action: input.action?.op ?? 'click',
      observationId: input.observation?.id ?? null,
      observationFingerprint: input.observation?.fingerprint ?? null,
      captureSha256: input.action?.captureSha256 ?? null,
      startedAt: input.startedAt,
      finishedAt: new Date(this.#now()).toISOString(),
      reason: input.reason,
      nativeAccepted: input.nativeAccepted,
      postAction: input.postAction,
    }
    const storedReceipt = structuredClone(receipt)
    state.receipts.push(storedReceipt)
    if (state.receipts.length > MAX_RECEIPTS_PER_SCOPE) {
      state.receiptsDropped += state.receipts.length - MAX_RECEIPTS_PER_SCOPE
      state.receipts.splice(0, state.receipts.length - MAX_RECEIPTS_PER_SCOPE)
    }
    return structuredClone(storedReceipt)
  }

  async act(requestedAction: ComputerAction, context: ComputerDriverContext): Promise<ComputerActionReceipt> {
    const action = immutableActionSnapshot(requestedAction)
    const scope = scopeId(context)
    const state = this.#state(scope)
    const startedAt = new Date(this.#now()).toISOString()
    if (this.#disposed || this.#hostPlatform !== 'darwin') {
      return this.#receipt(state, {
        status: 'failed', action, observation: null, startedAt,
        reason: this.#disposed ? 'dsh-computer driver is disposed' : new ComputerPlatformError(this.#hostPlatform).message,
        nativeAccepted: false, postAction: null,
      })
    }
    const located = state.refs.get(action.ref)
    if (!located) {
      const token = refObservationToken(action.ref)
      const evicted = token !== null && state.evictedObservations.has(token)
      return this.#receipt(state, {
        status: 'rejected', action, observation: null, startedAt,
        reason: evicted
          ? 'OBSERVATION_EVICTED: observation was evicted by driver memory bounds before its ref expired; run computer_observe again'
          : 'unknown reference in this Agent scope; run computer_observe again',
        nativeAccepted: false, postAction: null,
      })
    }
    const { observation, target } = located
    if (observation.expiresAtMs <= this.#now()) {
      this.#dropObservation(state, observation)
      return this.#receipt(state, {
        status: 'rejected', action, observation, startedAt,
        reason: 'stale observation; run computer_observe again',
        nativeAccepted: false, postAction: null,
      })
    }
    if (action.kind === 'type' && (typeof action.text !== 'string' || action.text.length > MAX_TYPE_LENGTH)) {
      return this.#receipt(state, {
        status: 'rejected', action, observation, startedAt,
        reason: `type text must be at most ${MAX_TYPE_LENGTH} characters`, nativeAccepted: false, postAction: null,
      })
    }
    if (action.kind === 'key' && (typeof action.key !== 'string'
      || ((action.key.trim() === '') && action.key !== '\n' && action.key !== '\r')
      || action.key.length > 32)) {
      return this.#receipt(state, {
        status: 'rejected', action, observation, startedAt,
        reason: 'key must be a non-empty supported key name', nativeAccepted: false, postAction: null,
      })
    }
    if (action.kind === 'scroll') {
      const amount = action.amount
      const invalidAmount = amount !== undefined
        && amount !== 'line' && amount !== 'page'
        && (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0)
      if ((action.direction !== 'up' && action.direction !== 'down') || invalidAmount) {
        return this.#receipt(state, {
          status: 'rejected', action, observation, startedAt,
          reason: 'scroll requires direction up/down and an optional positive line/page/point amount',
          nativeAccepted: false, postAction: null,
        })
      }
    }
    let initialRisk: ComputerActionRisk
    try {
      initialRisk = classifyComputerActionRisk(action, target.publicTarget)
      if (action.kind === 'key') normalizeModifiers(action.modifiers)
    } catch (error) {
      return this.#receipt(state, {
        status: 'rejected', action, observation, startedAt,
        reason: errorMessage(error), nativeAccepted: false, postAction: null,
      })
    }
    if (initialRisk.kind === 'hard-deny') {
      return this.#receipt(state, {
        status: 'rejected', action, observation, startedAt,
        reason: initialRisk.reason, nativeAccepted: false, postAction: null,
      })
    }

    if (state.busyObservations.has(observation.id)) {
      return this.#receipt(state, {
        status: 'rejected', action, observation, startedAt,
        reason: 'another operation is already using this observation', nativeAccepted: false, postAction: null,
      })
    }
    state.busyObservations.add(observation.id)
    const scopeGeneration = this.#scopeGeneration(scope)

    // A human's deliberation time must not consume the freshness budget. Record
    // how long the approval gate held before answering so every post-approval
    // TTL checkpoint is measured against the credited deadline
    // (expiresAtMs + approvalElapsedMs) instead of the raw expiry.
    let approvalElapsedMs = 0
    let approvalRisk: Extract<ComputerActionRisk, { kind: 'approval-required' }> | null = null

    const hardBindingFailure = (): string | null => {
      if (this.#disposed || this.#scopeGeneration(scope) !== scopeGeneration) {
        return 'Agent scope was disposed before action dispatch'
      }
      if (state.refs.get(action.ref) !== located) {
        return 'observation was consumed by another action; run computer_observe again'
      }
      return null
    }

    const bindingFailure = (): string | null => {
      const hard = hardBindingFailure()
      if (hard !== null) return hard
      // The freshness budget excludes ONLY the approval wait: the TTL is
      // evaluated against the credited deadline (expiresAtMs +
      // approvalElapsedMs). The grant never suspends the bound — any time
      // spent after approval on the window lock, the final preflight, or the
      // native dispatch counts against the TTL, and a stale observation fails
      // closed at every checkpoint exactly as the safe path does. The live
      // preflight still proves a real view change inside that window.
      const stale = observation.expiresAtMs + approvalElapsedMs <= this.#now()
      if (stale) {
        this.#dropObservation(state, observation)
        return 'observation expired before action dispatch; run computer_observe again'
      }
      return null
    }

    try {

      // Approval-required actions receive one read-only preflight before the
      // prompt, but never hold the global window lock while waiting on a user.
      if (initialRisk.kind === 'approval-required') {
        let preApprovalLive: NativeObservedNode
        try {
          preApprovalLive = await this.#preflight(scope, observation, target, context.signal)
        } catch (error) {
          const reason = error instanceof NativeHelperError ? `${error.code}: ${error.message}` : errorMessage(error)
          return this.#receipt(state, {
            status: preflightReceiptStatus(error), action, observation, startedAt,
            reason, nativeAccepted: false, postAction: null,
          })
        }
        const invalidBeforeApproval = bindingFailure()
        if (invalidBeforeApproval) {
          return this.#receipt(state, {
            status: 'rejected', action, observation, startedAt,
            reason: invalidBeforeApproval, nativeAccepted: false, postAction: null,
          })
        }
        const readiness = readinessError(action, preApprovalLive)
        const liveRisk = classifyComputerActionRisk(action, preApprovalLive)
        if (readiness !== null || liveRisk.kind !== 'approval-required' || liveRisk.code !== initialRisk.code) {
          return this.#receipt(state, {
            status: 'rejected', action, observation, startedAt,
            reason: readiness ?? (liveRisk.kind === 'hard-deny' ? liveRisk.reason
              : 'action risk changed during live preflight; run computer_observe again'),
            nativeAccepted: false, postAction: null,
          })
        }

        let outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' = 'unavailable'
        if (context.approval !== undefined) {
          const approvalStartedAtMs = this.#now()
          try {
            outcome = await context.approval.request(informedApprovalReason(action, initialRisk, observation, preApprovalLive))
          } catch {
            outcome = 'unavailable'
          }
          approvalElapsedMs = Math.max(0, this.#now() - approvalStartedAtMs)
        }
        if (outcome !== 'allowed-once') {
          return this.#receipt(state, {
            status: 'rejected', action, observation, startedAt,
            reason: approvalDenialReason(outcome, initialRisk), nativeAccepted: false, postAction: null,
          })
        }
        // A granted approval credits the human's wait time only. The clock can
        // still reject the action once the credited deadline passes, and a
        // live re-verification proves a real view change inside that window.
        approvalRisk = initialRisk
        const invalidAfterApproval = bindingFailure()
        if (invalidAfterApproval) {
          return this.#receipt(state, {
            status: 'rejected', action, observation, startedAt,
            reason: `approved action was not dispatched: ${invalidAfterApproval}`,
            nativeAccepted: false, postAction: null,
          })
        }
      }

      let releaseWindow: (() => void) | undefined
      try {
        try {
          releaseWindow = await this.#windowMutex.acquire(windowLockKey(observation), scope, context.signal)
        } catch (error) {
          return this.#receipt(state, {
            status: 'rejected', action, observation, startedAt,
            reason: errorMessage(error), nativeAccepted: false, postAction: null,
          })
        }

        const invalidAfterLock = bindingFailure()
        if (invalidAfterLock) {
          return this.#receipt(state, {
            status: 'rejected', action, observation, startedAt,
            reason: approvalRisk === null ? invalidAfterLock : `approved action was not dispatched: ${invalidAfterLock}`,
            nativeAccepted: false, postAction: null,
          })
        }

        let finalLive: NativeObservedNode
        try {
          finalLive = await this.#preflight(scope, observation, target, context.signal)
        } catch (error) {
          const reason = error instanceof NativeHelperError ? `${error.code}: ${error.message}` : errorMessage(error)
          return this.#receipt(state, {
            status: preflightReceiptStatus(error), action, observation, startedAt,
            reason: approvalRisk === null
              ? reason
              : error instanceof LivePreflightError
                ? `the view changed while you were deciding: ${reason}`
                : `approved action was not dispatched: ${reason}`,
            nativeAccepted: false, postAction: null,
          })
        }
        const invalidAfterFinalPreflight = bindingFailure()
        if (invalidAfterFinalPreflight) {
          return this.#receipt(state, {
            status: 'rejected', action, observation, startedAt,
            reason: approvalRisk === null
              ? invalidAfterFinalPreflight
              : `approved action was not dispatched: ${invalidAfterFinalPreflight}`,
            nativeAccepted: false, postAction: null,
          })
        }

        const finalReadiness = readinessError(action, finalLive)
        const finalRisk = classifyComputerActionRisk(action, finalLive)
        let approval: NativeApprovalGrant | null = null
        if (approvalRisk === null) {
          if (finalReadiness !== null || finalRisk.kind !== 'safe') {
            return this.#receipt(state, {
              status: 'rejected', action, observation, startedAt,
              reason: finalReadiness ?? (finalRisk.kind === 'hard-deny' ? finalRisk.reason
                : 'action now requires approval; run computer_observe again'),
              nativeAccepted: false, postAction: null,
            })
          }
        } else {
          if (finalReadiness !== null || finalRisk.kind !== 'approval-required' || finalRisk.code !== approvalRisk.code) {
            return this.#receipt(state, {
              status: 'rejected', action, observation, startedAt,
              reason: finalReadiness ?? (finalRisk.kind === 'hard-deny' ? finalRisk.reason
                : 'approved action risk changed during live revalidation; run computer_observe again'),
              nativeAccepted: false, postAction: null,
            })
          }
          approval = {
            outcome: 'allowed-once',
            observationId: observation.id,
            refDigest: createHash('sha256').update(`${scope}\u0000${observation.id}\u0000${action.ref}`).digest('hex'),
            riskCode: approvalRisk.code,
            observationFingerprint: observation.fingerprint,
            actionDigest: normalizedActionDigest(action),
            nonce: randomBytes(32).toString('base64url'),
          }
        }

        try {
          const nativeResult = await this.#native.request<NativeActionResult>({
            id: this.#id(),
            command: 'act',
            expected: {
              app: structuredClone(observation.native.app),
              window: structuredClone(observation.native.window),
              element: nativeElement(target.publicTarget),
              locator: [...target.nativeTarget.locator],
            },
            action: nativeAction(action),
            approval,
          }, {
            scopeId: scope,
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          })
          const result = structuredClone(nativeResult)
          const status = result.status === 'confirmed' && !confirmedByPost(action, target, observation, result)
            ? 'unknown'
            : result.status
          const reason = result.status === 'confirmed' && status === 'unknown'
            ? `native confirmation was downgraded: post-action identity or action-specific proof was missing; ${result.reason}`
            : result.reason
          const receipt = this.#receipt(state, {
            status,
            action,
            observation,
            startedAt,
            reason,
            nativeAccepted: result.accepted,
            postAction: postAction(result.post),
          })
          if (result.accepted || status === 'confirmed' || status === 'unknown') {
            this.#dropObservation(state, observation)
          }
          return receipt
        } catch (error) {
          const reason = error instanceof NativeHelperError ? `${error.code}: ${error.message}` : errorMessage(error)
          const outcomeUnknown = error instanceof NativeHelperError && error.mayHaveExecuted
          const receipt = this.#receipt(state, {
            status: outcomeUnknown ? 'unknown' : 'failed', action, observation, startedAt,
            reason: outcomeUnknown ? `action outcome is unknown after transport loss: ${reason}` : reason,
            nativeAccepted: false, postAction: null,
          })
          if (outcomeUnknown) this.#dropObservation(state, observation)
          return receipt
        }
      } finally {
        releaseWindow?.()
      }
    } finally {
      state.busyObservations.delete(observation.id)
    }
  }

  async visualAct(requestedAction: ComputerVisualAction, context: ComputerDriverContext): Promise<ComputerVisualActionReceipt> {
    const action = immutableVisualActionSnapshot(requestedAction)
    const scope = scopeId(context)
    const state = this.#state(scope)
    const startedAt = new Date(this.#now()).toISOString()
    if (this.#disposed || this.#hostPlatform !== 'darwin') {
      return this.#visualReceipt(state, {
        status: 'failed', action, observation: null, startedAt,
        reason: this.#disposed ? 'dsh-computer driver is disposed' : new ComputerPlatformError(this.#hostPlatform).message,
        nativeAccepted: false, postAction: null,
      })
    }

    this.#cleanExpired(state)
    const captureEntry = state.captures.get(action.captureSha256)
    if (captureEntry === undefined) {
      return this.#visualReceipt(state, {
        status: 'rejected', action, observation: null, startedAt,
        reason: 'unknown, stale, consumed, or wrong-owner capture in this Agent scope; run computer_observe/computer_visual_observe again',
        nativeAccepted: false, postAction: null,
      })
    }
    const { observation, binding } = captureEntry
    if (binding.consumed || binding.observationId !== action.observationId || observation.id !== action.observationId) {
      return this.#visualReceipt(state, {
        status: 'rejected', action, observation, startedAt,
        reason: 'capture binding does not match this observation or was already consumed; run computer_visual_observe again',
        nativeAccepted: false, postAction: null,
      })
    }
    if (state.observations.get(observation.id) !== observation) {
      return this.#visualReceipt(state, {
        status: 'rejected', action, observation, startedAt,
        reason: 'observation changed while resolving the visual capture; run computer_observe again',
        nativeAccepted: false, postAction: null,
      })
    }
    if (observation.expiresAtMs <= this.#now()) {
      this.#dropObservation(state, observation)
      return this.#visualReceipt(state, {
        status: 'rejected', action, observation, startedAt,
        reason: 'stale observation; run computer_observe again',
        nativeAccepted: false, postAction: null,
      })
    }
    const shapeError = visualActionShapeError(action, binding)
    if (shapeError !== null) {
      return this.#visualReceipt(state, {
        status: 'rejected', action, observation, startedAt,
        reason: shapeError, nativeAccepted: false, postAction: null,
      })
    }
    if (state.busyObservations.has(observation.id)) {
      return this.#visualReceipt(state, {
        status: 'rejected', action, observation, startedAt,
        reason: 'another operation is already using this observation', nativeAccepted: false, postAction: null,
      })
    }
    state.busyObservations.add(observation.id)
    const scopeGeneration = this.#scopeGeneration(scope)

    let approvalElapsedMs = 0
    const hardBindingFailure = (): string | null => {
      if (this.#disposed || this.#scopeGeneration(scope) !== scopeGeneration || this.#scopes.get(scope) !== state) {
        return 'Agent scope was disposed before visual action dispatch'
      }
      if (state.captures.get(action.captureSha256) !== captureEntry) {
        return 'capture binding was invalidated while the visual action was running'
      }
      return null
    }
    const bindingFailure = (): string | null => {
      const hard = hardBindingFailure()
      if (hard !== null) return hard
      const stale = observation.expiresAtMs + approvalElapsedMs <= this.#now()
      if (stale) {
        this.#dropObservation(state, observation)
        return 'observation expired before visual action dispatch; run computer_observe again'
      }
      return null
    }

    const captureRequest = () => ({
      id: this.#id(),
      capture: {
        app: structuredClone(binding.app),
        window: structuredClone(binding.window),
        targets: binding.targets.map(target => structuredClone(target)),
      },
    })

    const liveFresh = async (phase: 'pre-approval' | 'post-approval'): Promise<{
      native: NativeObserveResult
      secureReason: string | null
      capturedSha256: string
    }> => {
      const live = await this.#preflightWindow(scope, observation, context.signal)
      const invalid = bindingFailure()
      if (invalid !== null) throw new LivePreflightError(invalid)
      const captured = await this.#capture(this.#native, captureRequest(), {
        scopeId: scope,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      })
      const afterCapture = bindingFailure()
      if (afterCapture !== null) throw new LivePreflightError(afterCapture)
      if (captured.result.artifact.sha256 !== binding.captureSha256) {
        throw new LivePreflightError(
          `${phase} window content changed (capture ${binding.captureSha256.slice(0, 12)}… is no longer fresh); run computer_visual_observe again`,
        )
      }
      return {
        native: live,
        secureReason: visualSecurePointError(action, binding, live.nodes),
        capturedSha256: captured.result.artifact.sha256,
      }
    }

    try {
      // Visual point actions always need the exact unknown-target approval.
      if (context.approval === undefined) {
        return this.#visualReceipt(state, {
          status: 'rejected', action, observation, startedAt,
          reason: visualApprovalDenialReason('unavailable'), nativeAccepted: false, postAction: null,
        })
      }

      let releaseWindow: (() => void) | undefined
      try {
        releaseWindow = await this.#windowMutex.acquire(windowLockKey(observation), scope, context.signal)
        try {
          const freshBefore = await liveFresh('pre-approval')
          const invalidBeforeApproval = bindingFailure()
          if (invalidBeforeApproval !== null) {
            return this.#visualReceipt(state, {
              status: 'rejected', action, observation, startedAt,
              reason: invalidBeforeApproval, nativeAccepted: false, postAction: null,
            })
          }
          if (freshBefore.secureReason !== null) {
            return this.#visualReceipt(state, {
              status: 'rejected', action, observation, startedAt,
              reason: freshBefore.secureReason,
              nativeAccepted: false, postAction: null,
            })
          }
        } catch (error) {
          const reason = error instanceof NativeHelperError ? `${error.code}: ${error.message}` : errorMessage(error)
          return this.#visualReceipt(state, {
            status: preflightReceiptStatus(error), action, observation, startedAt,
            reason: error instanceof LivePreflightError ? `the view changed before approval: ${reason}` : reason,
            nativeAccepted: false, postAction: null,
          })
        }
      } finally {
        releaseWindow?.()
      }

      let outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' = 'unavailable'
      if (context.approval !== undefined) {
        const approvalStartedAtMs = this.#now()
        try {
          outcome = await context.approval.request(informedVisualApprovalReason(action, observation, binding))
        } catch {
          outcome = 'unavailable'
        }
        approvalElapsedMs = Math.max(0, this.#now() - approvalStartedAtMs)
      }
      if (outcome !== 'allowed-once') {
        return this.#visualReceipt(state, {
          status: 'rejected', action, observation, startedAt,
          reason: visualApprovalDenialReason(outcome), nativeAccepted: false, postAction: null,
        })
      }
      const invalidAfterApproval = bindingFailure()
      if (invalidAfterApproval !== null) {
        return this.#visualReceipt(state, {
          status: 'rejected', action, observation, startedAt,
          reason: `approved visual action was not dispatched: ${invalidAfterApproval}`,
          nativeAccepted: false, postAction: null,
        })
      }

      try {
        releaseWindow = await this.#windowMutex.acquire(windowLockKey(observation), scope, context.signal)
      } catch (error) {
        return this.#visualReceipt(state, {
          status: 'rejected', action, observation, startedAt,
          reason: errorMessage(error), nativeAccepted: false, postAction: null,
        })
      }

      try {
        let freshAfter: Awaited<ReturnType<typeof liveFresh>>
        try {
          freshAfter = await liveFresh('post-approval')
          const invalidAfterFresh = bindingFailure()
          if (invalidAfterFresh !== null) {
            return this.#visualReceipt(state, {
              status: 'rejected', action, observation, startedAt,
              reason: `approved visual action was not dispatched: ${invalidAfterFresh}`,
              nativeAccepted: false, postAction: null,
            })
          }
          if (freshAfter.secureReason !== null) {
            return this.#visualReceipt(state, {
              status: 'rejected', action, observation, startedAt,
              reason: `approved visual action was not dispatched: ${freshAfter.secureReason}`,
              nativeAccepted: false, postAction: null,
            })
          }
        } catch (error) {
          const reason = error instanceof NativeHelperError ? `${error.code}: ${error.message}` : errorMessage(error)
          return this.#visualReceipt(state, {
            status: preflightReceiptStatus(error), action, observation, startedAt,
            reason: error instanceof LivePreflightError
              ? `the view changed while you were deciding: ${reason}`
              : `approved visual action was not dispatched: ${reason}`,
            nativeAccepted: false, postAction: null,
          })
        }

        const approval: NativeApprovalGrant = {
          outcome: 'allowed-once',
          observationId: observation.id,
          refDigest: createHash('sha256').update(`${scope}\u0000${observation.id}\u0000visual-act\u0000${binding.captureSha256}`).digest('hex'),
          riskCode: 'visual-point-action',
          observationFingerprint: observation.fingerprint,
          actionDigest: normalizedVisualActionDigest(action, binding),
          nonce: randomBytes(32).toString('base64url'),
        }
        try {
          const nativeResult = await this.#native.request<NativeVisualActResult>({
            id: this.#id(),
            command: 'visual-act',
            visual: {
              app: structuredClone(freshAfter.native.app),
              window: structuredClone(freshAfter.native.window as ComputerCapturableWindowIdentity),
              captureSha256: binding.captureSha256,
              targets: binding.targets.map(target => structuredClone(target)),
              action: nativeVisualAction(action),
              approval,
            },
          }, {
            scopeId: scope,
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          })
          const result = structuredClone(nativeResult)
          // A visual coordinate path never has AX-specific proof; even a
          // native helper that reports confirmed is treated as unknown until
          // the consumer re-observes the actual UI effect.
          const status: ComputerActionStatus = result.status === 'confirmed' ? 'unknown' : result.status
          const reason = result.status === 'confirmed'
            ? `native helper reported visual dispatch confirmation; visible outcome still requires re-observation: ${result.reason}`
            : result.reason
          const receipt = this.#visualReceipt(state, {
            status, action, observation, startedAt,
            reason, nativeAccepted: result.accepted,
            postAction: postAction(result.post),
          })
          if (result.accepted || status === 'unknown') {
            binding.consumed = true
            this.#dropObservation(state, observation)
          }
          return receipt
        } catch (error) {
          const reason = error instanceof NativeHelperError ? `${error.code}: ${error.message}` : errorMessage(error)
          const outcomeUnknown = error instanceof NativeHelperError && error.mayHaveExecuted
          const receipt = this.#visualReceipt(state, {
            status: outcomeUnknown ? 'unknown' : 'failed', action, observation, startedAt,
            reason: outcomeUnknown ? `visual action outcome is unknown after transport loss: ${reason}` : reason,
            nativeAccepted: false, postAction: null,
          })
          if (outcomeUnknown) {
            binding.consumed = true
            this.#dropObservation(state, observation)
          }
          return receipt
        }
      } finally {
        releaseWindow?.()
      }
    } finally {
      state.busyObservations.delete(observation.id)
    }
  }

  async listApps(context: ComputerDriverContext): Promise<ComputerAppList> {
    this.#assertLive()
    const result = await this.#native.request<NativeAppsResult>({ id: this.#id(), command: 'apps' }, {
      scopeId: scopeId(context),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    })
    if (!Array.isArray(result.apps) || typeof result.truncated !== 'boolean' || typeof result.accessibilityTrusted !== 'boolean') {
      throw new NativeHelperError('invalid_helper_response', 'computer_apps: native helper returned a malformed list')
    }
    return {
      apps: result.apps.map(app => runningApp(app, 'computer_apps')),
      truncated: result.truncated,
      accessibilityTrusted: result.accessibilityTrusted,
    }
  }

  async launchApp(request: ComputerLaunchRequest, context: ComputerDriverContext): Promise<ComputerLaunchResult> {
    this.#assertLive()
    const bundleId = validBundleId(request.bundleId, 'computer_launch')
    const result = await this.#native.request<NativeLaunchResult>({ id: this.#id(), command: 'launch', launch: { bundleId } }, {
      scopeId: scopeId(context),
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    })
    if (typeof result.launched !== 'boolean') {
      throw new NativeHelperError('invalid_helper_response', 'computer_launch: native helper returned a malformed result')
    }
    const app = runningApp(result.app, 'computer_launch')
    if (app.bundleId !== bundleId) {
      throw new NativeHelperError('invalid_helper_response', `computer_launch: helper reported ${app.bundleId}, expected ${bundleId}`)
    }
    return { launched: result.launched, app }
  }

  async evidence(context: ComputerDriverContext, options: { limit?: number } = {}): Promise<ComputerEvidence> {
    const scope = scopeId(context)
    const state = this.#state(scope)
    this.#cleanExpired(state)
    const limit = integerInRange(options.limit, 20, 1, 100)
    let status: ComputerHelperStatus
    if (this.#hostPlatform !== 'darwin') {
      status = emptyHelperStatus('unsupported', new ComputerPlatformError(this.#hostPlatform).message)
    } else if (this.#disposed) {
      status = emptyHelperStatus('macos', 'driver disposed')
    } else {
      try {
        const nativeStatus = await this.#native.request<NativeStatusResult>({ id: this.#id(), command: 'status' }, {
          scopeId: scope,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        })
        status = {
          platform: 'macos',
          helper: 'ready',
          accessibilityTrusted: nativeStatus.accessibilityTrusted,
          screenRecordingTrusted: nativeStatus.screenRecordingTrusted,
          sessionLocked: nativeStatus.sessionLocked,
          interactiveSessionAvailable: nativeStatus.interactiveSessionAvailable,
          helperVersion: nativeStatus.helperVersion,
          helperExecutable: nativeStatus.helperExecutable,
          bundle: structuredClone(nativeStatus.bundle),
          signing: structuredClone(nativeStatus.signing),
          process: structuredClone(nativeStatus.process),
          caller: structuredClone(nativeStatus.caller),
          resolution: structuredClone(nativeStatus.resolution),
          identityStable: nativeStatus.identityStable,
          detail: `native helper ${nativeStatus.helperVersion}; interactive session ${nativeStatus.interactiveSessionAvailable ? 'available' : nativeStatus.sessionLocked ? 'locked' : 'unavailable/unknown'}; Accessibility ${nativeStatus.accessibilityTrusted ? 'trusted' : 'not granted'}; Screen Recording ${nativeStatus.screenRecordingTrusted ? 'trusted' : 'not granted'}; identity ${nativeStatus.identityStable ? 'stable' : 'development/unstable'}`,
        }
      } catch (error) {
        status = emptyHelperStatus('macos', errorMessage(error))
      }
    }
    // The awaited native status request can take arbitrarily long: re-run
    // expiry cleanup so activeObservations reflects the projection instant,
    // not the instant before the status call began.
    this.#cleanExpired(state)
    const receipts = state.receipts
      .slice(-limit)
      .map(receipt => structuredClone(receipt))
    return {
      contractVersion: COMPUTER_DRIVER_CONTRACT_VERSION,
      scope: scopeLabel(scope),
      status,
      activeObservations: state.observations.size,
      activeNativeRequests: this.#native.active(scope),
      receipts,
      receipts_total: state.sequence,
      receipts_dropped: state.receiptsDropped,
      receipts_returned: receipts.length,
      bounded: true,
    }
  }

  async disposeScope(scope: string): Promise<void> {
    this.#scopeGenerations.set(scope, this.#scopeGeneration(scope) + 1)
    this.#scopes.delete(scope)
    this.#windowMutex.cancelScope(scope)
    await this.#native.disposeScope(scope)
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#scopes.clear()
    this.#scopeGenerations.clear()
    this.#windowMutex.dispose()
    await this.#native.dispose()
  }
}
