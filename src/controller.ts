import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type {
  ComputerAction,
  ComputerActionReceipt,
  ComputerActionStatus,
  ComputerDriver,
  ComputerDriverContext,
  ComputerEvidence,
  ComputerHelperStatus,
  ComputerObservation,
  ComputerObserveRequest,
  ComputerPostActionObservation,
  ComputerTarget,
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
  NativeElementIdentity,
  NativeObserveResult,
  NativeObservedNode,
  NativeStatusResult,
  NativeTransport,
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
const MAX_OBSERVATIONS_PER_SCOPE = 8
const MAX_RECEIPTS_PER_SCOPE = 100
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

interface ObservationRecord {
  id: string
  fingerprint: string
  capturedAt: string
  expiresAtMs: number
  expiresAt: string
  native: NativeObserveResult
  targets: Map<string, ObservationTargetRecord>
  limits: { maxDepth: number; maxNodes: number }
}

interface ScopeState {
  observations: Map<string, ObservationRecord>
  refs: Map<string, { observation: ObservationRecord; target: ObservationTargetRecord }>
  receipts: ComputerActionReceipt[]
  sequence: number
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

function scopeId(context: ComputerDriverContext): string {
  if (typeof context.scopeId !== 'string' || context.scopeId.trim() === '' || context.scopeId.length > 256) {
    throw new Error('a non-empty host-derived scopeId of at most 256 characters is required')
  }
  return context.scopeId
}

function scopeLabel(scope: string): string {
  return createHash('sha256').update(scope).digest('hex').slice(0, 12)
}

function markPriority(target: ObservationTargetRecord): number {
  const node = target.nativeTarget
  if (node.frame === null) return 2
  if (node.role === 'AXWindow' || node.role === 'AXApplication') return 1
  if (node.enabled !== false && (node.actions.length > 0 || INTERACTIVE_AX_ROLES.has(node.role))) return 0
  return 1
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

function nativeAction(action: ComputerAction): NativeActionPayload {
  switch (action.kind) {
    case 'click': return { kind: 'click' }
    case 'focus': return { kind: 'focus' }
    case 'type': return { kind: 'type', text: action.text }
    case 'key': return { kind: 'key', key: normalizeKeyName(action.key), modifiers: normalizeModifiers(action.modifiers) }
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

function appMatches(expected: NativeObserveResult['app'], live: NativeObserveResult['app']): boolean {
  return expected.bundleId === live.bundleId
    && expected.pid === live.pid
    && expected.launchIdentity !== null
    && expected.launchIdentity === live.launchIdentity
}

function windowMatches(expected: NativeObserveResult['window'], live: NativeObserveResult['window']): boolean {
  return (expected.number !== null ? live.number === expected.number : live.identity === expected.identity)
    && expected.role === live.role
    && expected.subrole === live.subrole
    && expected.title === live.title
    && frameMatches(expected.frame, live.frame)
}

function elementMatches(expected: NativeObservedNode, live: NativeObservedNode): boolean {
  return expected.role === live.role
    && expected.subrole === live.subrole
    && expected.identifier === live.identifier
    && expected.name === live.name
    && expected.secure === live.secure
    && frameMatches(expected.frame, live.frame)
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
      observations: new Map(), refs: new Map(), receipts: [], sequence: 0, busyObservations: new Set(),
    }
    this.#scopes.set(scope, created)
    return created
  }

  #scopeGeneration(scope: string): number {
    return this.#scopeGenerations.get(scope) ?? 0
  }

  #dropObservation(state: ScopeState, observation: ObservationRecord): void {
    state.observations.delete(observation.id)
    for (const ref of observation.targets.keys()) state.refs.delete(ref)
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
      this.#dropObservation(state, oldest)
    }

    const observedAtMs = this.#now()
    const id = `obs_${this.#id()}`
    const expiresAtMs = observedAtMs + ttlMs
    const record: ObservationRecord = {
      id,
      fingerprint: fingerprint(result),
      capturedAt: result.capturedAt,
      expiresAtMs,
      expiresAt: new Date(expiresAtMs).toISOString(),
      native: result,
      targets: new Map(),
      limits: { maxDepth, maxNodes },
    }
    for (const [sourceIndex, node] of result.nodes.entries()) {
      const ref = `cu_${randomBytes(18).toString('base64url')}`
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
      const targets = [...observation.targets.values()]
        // SoM is an action map, not an Accessibility debug overlay. Static
        // labels remain visible in the screenshot/AX JSON but do not receive
        // opaque action numbers that the driver could never safely dispatch.
        .filter(target => target.nativeTarget.frame !== null && markPriority(target) === 0)
        .sort((left, right) => markPriority(left) - markPriority(right) || left.sourceIndex - right.sourceIndex)
        .slice(0, maxMarks)
        .map(target => ({
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
        omitted: captured.result.omitted.map(omission => ({
          ref: omission.ref,
          sourceIndex: omission.index,
          reason: omission.reason,
        })),
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
    if (!appMatches(observation.native.app, result.app)) {
      throw new LivePreflightError('live application identity changed; run computer_observe again')
    }
    if (!windowMatches(observation.native.window, result.window)) {
      throw new LivePreflightError('live window identity changed; run computer_observe again')
    }
    if (fingerprint(result) !== observation.fingerprint) {
      throw new LivePreflightError('live observation fingerprint changed; run computer_observe again')
    }
    const live = result.nodes.find(node => locatorMatches(node.locator, target.nativeTarget.locator))
    if (!live || !elementMatches(target.nativeTarget, live)) {
      throw new LivePreflightError('live target identity changed; run computer_observe again')
    }
    return live
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
    if (state.receipts.length > MAX_RECEIPTS_PER_SCOPE) state.receipts.splice(0, state.receipts.length - MAX_RECEIPTS_PER_SCOPE)
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
      return this.#receipt(state, {
        status: 'rejected', action, observation: null, startedAt,
        reason: 'unknown reference in this Agent scope; run computer_observe again',
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
    const bindingFailure = (): string | null => {
      if (this.#disposed || this.#scopeGeneration(scope) !== scopeGeneration) {
        return 'Agent scope was disposed before action dispatch'
      }
      if (state.refs.get(action.ref) !== located) return 'observation was consumed by another action; run computer_observe again'
      if (observation.expiresAtMs <= this.#now()) {
        this.#dropObservation(state, observation)
        return 'observation expired before action dispatch; run computer_observe again'
      }
      return null
    }

    try {
      let approvalRisk: Extract<ComputerActionRisk, { kind: 'approval-required' }> | null = null

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
          try {
            outcome = await context.approval.request(informedApprovalReason(action, initialRisk, observation, preApprovalLive))
          } catch {
            outcome = 'unavailable'
          }
        }
        if (outcome !== 'allowed-once') {
          return this.#receipt(state, {
            status: 'rejected', action, observation, startedAt,
            reason: approvalDenialReason(outcome, initialRisk), nativeAccepted: false, postAction: null,
          })
        }
        const invalidAfterApproval = bindingFailure()
        if (invalidAfterApproval) {
          return this.#receipt(state, {
            status: 'rejected', action, observation, startedAt,
            reason: `approved action was not dispatched: ${invalidAfterApproval}`,
            nativeAccepted: false, postAction: null,
          })
        }
        approvalRisk = initialRisk
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
            reason: approvalRisk === null ? reason : `approved action was not dispatched after live revalidation: ${reason}`,
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
    return {
      contractVersion: COMPUTER_DRIVER_CONTRACT_VERSION,
      scope: scopeLabel(scope),
      status,
      activeObservations: state.observations.size,
      activeNativeRequests: this.#native.active(scope),
      receipts: state.receipts.slice(-limit).map(receipt => structuredClone(receipt)),
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
