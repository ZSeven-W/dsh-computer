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
} from './contracts.js'
import { COMPUTER_DRIVER_CONTRACT_VERSION } from './contracts.js'
import { ComputerPlatformError, NativeHelper, NativeHelperError } from './native-helper.js'
import type {
  NativeActionPayload,
  NativeActionResult,
  NativeElementIdentity,
  NativeObserveResult,
  NativeObservedNode,
  NativeStatusResult,
  NativeTransport,
} from './native-protocol.js'
import { deterministicRiskReason, normalizeModifiers } from './policy.js'

const DEFAULT_MAX_DEPTH = 4
const DEFAULT_MAX_NODES = 200
const DEFAULT_TTL_MS = 15_000
const MIN_TTL_MS = 1_000
const MAX_TTL_MS = 30_000
const MAX_OBSERVATIONS_PER_SCOPE = 8
const MAX_RECEIPTS_PER_SCOPE = 100
const MAX_TYPE_LENGTH = 8_192

interface ObservationTargetRecord {
  publicTarget: ComputerTarget
  nativeTarget: NativeObservedNode
}

interface ObservationRecord {
  id: string
  fingerprint: string
  capturedAt: string
  expiresAtMs: number
  expiresAt: string
  native: NativeObserveResult
  targets: Map<string, ObservationTargetRecord>
}

interface ScopeState {
  observations: Map<string, ObservationRecord>
  refs: Map<string, { observation: ObservationRecord; target: ObservationTargetRecord }>
  receipts: ComputerActionReceipt[]
  sequence: number
}

export interface ComputerControllerOptions {
  native?: NativeTransport
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
    nodes: observation.nodes.map(node => ({
      locator: node.locator,
      role: node.role,
      subrole: node.subrole,
      name: node.name,
      identifier: node.identifier,
      frame: node.frame,
      enabled: node.enabled,
      focused: node.focused,
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
    frame: node.frame,
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
    frame: target.frame,
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
    app: value.app,
    window: value.window,
    target: value.target === null ? null : {
      role: value.target.role,
      subrole: value.target.subrole,
      name: value.target.name,
      identifier: value.target.identifier,
      frame: value.target.frame,
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
    case 'key': return { kind: 'key', key: action.key, modifiers: normalizeModifiers(action.modifiers) }
  }
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

/** Runtime implementation shared by DSH tools and the Cordis driver service. */
export class ComputerController implements ComputerDriver {
  readonly kind = 'computer' as const
  readonly platform = 'macos' as const
  readonly contractVersion = COMPUTER_DRIVER_CONTRACT_VERSION
  readonly #native: NativeTransport
  readonly #now: () => number
  readonly #id: () => string
  readonly #hostPlatform: NodeJS.Platform
  readonly #scopes = new Map<string, ScopeState>()
  readonly #scopeGenerations = new Map<string, number>()
  #disposed = false

  constructor(options: ComputerControllerOptions = {}) {
    this.#native = options.native ?? new NativeHelper()
    this.#now = options.now ?? Date.now
    this.#id = options.id ?? randomUUID
    this.#hostPlatform = options.platform ?? process.platform
  }

  #state(scope: string): ScopeState {
    const existing = this.#scopes.get(scope)
    if (existing) return existing
    const created: ScopeState = { observations: new Map(), refs: new Map(), receipts: [], sequence: 0 }
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
    this.#assertLive()
    const scope = scopeId(context)
    const scopeGeneration = this.#scopeGeneration(scope)
    const maxDepth = integerInRange(request.maxDepth, DEFAULT_MAX_DEPTH, 1, 8)
    const maxNodes = integerInRange(request.maxNodes, DEFAULT_MAX_NODES, 1, 500)
    const ttlMs = integerInRange(request.ttlMs, DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS)
    const result = await this.#native.request<NativeObserveResult>({
      id: this.#id(),
      command: 'observe',
      app: request.app ?? null,
      window: request.window ?? null,
      maxDepth,
      maxNodes,
    }, {
      scopeId: scope,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    })

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
    }
    for (const node of result.nodes) {
      const ref = `cu_${randomBytes(18).toString('base64url')}`
      const target: ObservationTargetRecord = { publicTarget: publicTarget(ref, node), nativeTarget: node }
      record.targets.set(ref, target)
      state.refs.set(ref, { observation: record, target })
    }
    state.observations.set(id, record)

    return {
      observationId: id,
      fingerprint: record.fingerprint,
      capturedAt: record.capturedAt,
      expiresAt: record.expiresAt,
      app: result.app,
      window: result.window,
      targets: [...record.targets.values()].map(target => target.publicTarget),
      truncated: result.truncated,
      limits: { maxDepth, maxNodes, ttlMs },
    }
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
    state.receipts.push(receipt)
    if (state.receipts.length > MAX_RECEIPTS_PER_SCOPE) state.receipts.splice(0, state.receipts.length - MAX_RECEIPTS_PER_SCOPE)
    return receipt
  }

  async act(action: ComputerAction, context: ComputerDriverContext): Promise<ComputerActionReceipt> {
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
    if (action.kind === 'key' && (typeof action.key !== 'string' || action.key.trim() === '' || action.key.length > 32)) {
      return this.#receipt(state, {
        status: 'rejected', action, observation, startedAt,
        reason: 'key must be a non-empty supported key name', nativeAccepted: false, postAction: null,
      })
    }
    let risk: string | null
    try {
      risk = deterministicRiskReason(action, target.publicTarget)
      if (action.kind === 'key') normalizeModifiers(action.modifiers)
    } catch (error) {
      return this.#receipt(state, {
        status: 'rejected', action, observation, startedAt,
        reason: errorMessage(error), nativeAccepted: false, postAction: null,
      })
    }
    if (risk) {
      return this.#receipt(state, {
        status: 'rejected', action, observation, startedAt,
        reason: risk, nativeAccepted: false, postAction: null,
      })
    }

    try {
      const result = await this.#native.request<NativeActionResult>({
        id: this.#id(),
        command: 'act',
        expected: {
          app: observation.native.app,
          window: observation.native.window,
          element: nativeElement(target.publicTarget),
          locator: [...target.nativeTarget.locator],
        },
        action: nativeAction(action),
      }, {
        scopeId: scope,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      })
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
      // An observation is a one-mutation capability. Once the helper accepted
      // an operation (or reports an ambiguous outcome), every sibling ref from
      // that same tree is invalidated. A later step must re-observe live state.
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
  }

  async evidence(context: ComputerDriverContext, options: { limit?: number } = {}): Promise<ComputerEvidence> {
    const scope = scopeId(context)
    const state = this.#state(scope)
    this.#cleanExpired(state)
    const limit = integerInRange(options.limit, 20, 1, 100)
    let status: ComputerHelperStatus
    if (this.#hostPlatform !== 'darwin') {
      status = {
        platform: 'unsupported', helper: 'unavailable', accessibilityTrusted: null,
        detail: new ComputerPlatformError(this.#hostPlatform).message,
      }
    } else if (this.#disposed) {
      status = { platform: 'macos', helper: 'unavailable', accessibilityTrusted: null, detail: 'driver disposed' }
    } else {
      try {
        const nativeStatus = await this.#native.request<NativeStatusResult>({ id: this.#id(), command: 'status' }, {
          scopeId: scope,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
        })
        status = {
          platform: 'macos', helper: 'ready', accessibilityTrusted: nativeStatus.accessibilityTrusted,
          detail: nativeStatus.accessibilityTrusted
            ? `native helper ${nativeStatus.helperVersion}; Accessibility trusted`
            : `native helper ${nativeStatus.helperVersion}; Accessibility permission is not granted`,
        }
      } catch (error) {
        status = { platform: 'macos', helper: 'unavailable', accessibilityTrusted: null, detail: errorMessage(error) }
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
    await this.#native.disposeScope(scope)
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#scopes.clear()
    this.#scopeGenerations.clear()
    await this.#native.dispose()
  }
}
