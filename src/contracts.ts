/** Stable service name exposed through Cordis for dsh-qa and other drivers. */
export const COMPUTER_DRIVER_SERVICE = 'zsevenComputerDriver' as const

export const COMPUTER_DRIVER_CONTRACT_VERSION = 4 as const

export interface ComputerFrame {
  x: number
  y: number
  width: number
  height: number
}

export interface ComputerAppSelector {
  /** Exact application bundle identifier. Prefer this over a display name. */
  bundleId?: string
  /** Exact live process identifier. May be combined with bundleId. */
  pid?: number
}

export interface ComputerWindowSelector {
  /** Accessibility window number when the target exposes one. */
  number?: number
  /** Exact title. Duplicate titles are rejected instead of guessed. */
  title?: string
}

export interface ComputerObserveRequest {
  /** Omit to observe the current frontmost application. */
  app?: ComputerAppSelector
  /** Omit to select the focused, main, or sole first window in that order. */
  window?: ComputerWindowSelector
  /** Accessibility traversal depth, clamped to 1...8. */
  maxDepth?: number
  /** Node budget, clamped to 1...500. */
  maxNodes?: number
  /** Observation lifetime in milliseconds, clamped to 1,000...30,000. */
  ttlMs?: number
}

export interface ComputerAppIdentity {
  bundleId: string
  pid: number
  /** Launch date plus executable identity when macOS exposes both. */
  launchIdentity: string | null
  name: string | null
}

export interface ComputerWindowIdentity {
  /** Strongest identity available from the Accessibility window. */
  number: number | null
  role: string
  subrole: string | null
  title: string | null
  frame: ComputerFrame | null
  /** Digest of immutable identity fields; not an actionable reference. */
  identity: string
}

export interface ComputerTarget {
  /** Opaque, scope-bound, expiring action reference. */
  ref: string
  role: string
  subrole: string | null
  name: string | null
  identifier: string | null
  frame: ComputerFrame | null
  enabled: boolean | null
  focused: boolean | null
  secure: boolean
  actions: string[]
  /** Non-secure, bounded textual value when Accessibility exposes one. */
  value: string | null
  depth: number
}

export interface ComputerObservation {
  observationId: string
  fingerprint: string
  capturedAt: string
  expiresAt: string
  app: ComputerAppIdentity
  window: ComputerWindowIdentity
  targets: ComputerTarget[]
  truncated: boolean
  limits: {
    maxDepth: number
    maxNodes: number
    ttlMs: number
  }
}

export interface ComputerVisualObserveRequest {
  /** Exact opaque observation id returned by computer_observe in the same Agent scope. */
  observationId: string
  /** Set-of-Mark budget, clamped to 1...200. Defaults to 80. */
  maxMarks?: number
}

export type ComputerCapturableWindowIdentity = Omit<ComputerWindowIdentity, 'number' | 'frame'> & {
  number: number
  frame: ComputerFrame
}

export interface ComputerVisualQuality {
  classification: 'usable' | 'transparent' | 'mostly-transparent' | 'near-black' | 'near-white' | 'near-uniform'
  usable: boolean
  sampleCount: number
  visibleFraction: number
  meanLuminance: number
  luminanceVariance: number
  luminanceRange: number
  darkFraction: number
  lightFraction: number
  distinctColorBuckets: number
}

export interface ComputerVisualMark {
  number: number
  /** Opaque action ref from the source observation. */
  ref: string
  /** Stable zero-based index in the source Accessibility observation. */
  sourceIndex: number
  /** Top-origin pixels in the native captured PNG, before attachment normalization. */
  nativePixelFrame: ComputerFrame
}

export interface ComputerVisualOmission {
  ref: string
  sourceIndex: number
  reason: string
}

/**
 * Driver-level visual result. The PNG remains in process memory for the host
 * attachment service; model-facing tool JSON must project metadata only.
 */
export interface ComputerVisualCapture {
  observationId: string
  observationFingerprint: string
  capturedAt: string
  expiresAt: string
  app: ComputerAppIdentity
  window: ComputerCapturableWindowIdentity
  png: Uint8Array
  capture: {
    artifact: {
      format: 'png'
      byteLength: number
      sha256: string
    }
    pointFrame: ComputerFrame
    pixelWidth: number
    pixelHeight: number
    scaleX: number
    scaleY: number
    quality: ComputerVisualQuality
  }
  marks: ComputerVisualMark[]
  omitted: ComputerVisualOmission[]
}

export type ComputerModifier = 'command' | 'control' | 'option' | 'shift' | 'fn'

export type ComputerScrollDirection = 'up' | 'down'

export type ComputerScrollAmount = 'line' | 'page' | number

/**
 * One bound action against a fresh observation ref. Scroll targets the
 * scrollable Accessibility container that contains (or is) the referenced
 * element and, like AXPress, its receipt is honest rather than optimistic: a
 * successful dispatch is reported as 'unknown', and whether content actually
 * moved is decided by re-observation, never inferred from the receipt. A scroll
 * whose live window/app identity no longer matches is rejected exactly like
 * every other action.
 */
export type ComputerAction =
  | { kind: 'click'; ref: string }
  | { kind: 'focus'; ref: string }
  | { kind: 'type'; ref: string; text: string }
  | { kind: 'key'; ref: string; key: string; modifiers?: ComputerModifier[] }
  | { kind: 'scroll'; ref: string; direction: ComputerScrollDirection; amount?: ComputerScrollAmount }

export interface ComputerPostActionObservation {
  capturedAt: string
  app: ComputerAppIdentity
  window: ComputerWindowIdentity
  target: Omit<ComputerTarget, 'ref' | 'depth'> | null
}

export type ComputerActionStatus = 'confirmed' | 'unknown' | 'rejected' | 'failed'

export interface ComputerActionReceipt {
  receiptId: string
  sequence: number
  status: ComputerActionStatus
  action: ComputerAction['kind']
  ref: string
  observationId: string | null
  observationFingerprint: string | null
  startedAt: string
  finishedAt: string
  reason: string
  nativeAccepted: boolean
  postAction: ComputerPostActionObservation | null
}

export interface ComputerHelperStatus {
  platform: 'macos' | 'unsupported'
  helper: 'ready' | 'not-built' | 'unavailable'
  accessibilityTrusted: boolean | null
  screenRecordingTrusted: boolean | null
  sessionLocked: boolean | null
  interactiveSessionAvailable: boolean | null
  helperVersion: string | null
  helperExecutable: string | null
  bundle: {
    path: string | null
    identifier: string | null
    version: string | null
  } | null
  signing: {
    signed: boolean
    kind: 'development' | 'developer-id' | 'distribution' | 'other' | 'adhoc' | 'unsigned'
    codeIdentifier: string | null
    teamIdentifier: string | null
    authorities: string[]
    cdhash: string | null
    statusCode: number
    detail: string | null
  } | null
  process: {
    pid: number
    ppid: number
  } | null
  caller: {
    pid: number
    executable: string | null
    bundleIdentifier: string | null
    name: string | null
  } | null
  resolution: {
    source: 'explicit-override' | 'installed-app' | 'worktree-build' | 'cache-build'
    selectedPath: string
  } | null
  identityStable: boolean | null
  detail: string
}

export interface ComputerEvidence {
  contractVersion: typeof COMPUTER_DRIVER_CONTRACT_VERSION
  scope: string
  status: ComputerHelperStatus
  activeObservations: number
  activeNativeRequests: number
  receipts: ComputerActionReceipt[]
  /** Receipts ever recorded in this scope (monotonically increasing). */
  receipts_total: number
  /** Receipts evicted from the bounded ring because it exceeded its cap. */
  receipts_dropped: number
  /** Receipts actually present in `receipts` (bounded by the requested limit). */
  receipts_returned: number
  /** Always true: the receipt ring is bounded; use the counters above to detect truncation. */
  bounded: true
}

/** Closed vocabulary returned by DSH's host-owned approval service. */
export type ComputerApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * A one-call approval gate bound by the host tool runtime. It deliberately
 * carries no Agent or call id: those are captured from ToolRunContext by the
 * computer_act implementation and can never come from model arguments.
 */
export interface ComputerApprovalGate {
  request(reason: string): Promise<ComputerApprovalOutcome>
}

/**
 * Context supplied by a trusted host integration. `scopeId` must come from the
 * live Agent/session identity, never from model arguments.
 */
export interface ComputerDriverContext {
  scopeId: string
  signal?: AbortSignal
  /** Present only for a host tool execution that can ask the owning user. */
  approval?: ComputerApprovalGate
}

/** Public, implementation-neutral contract consumed by dsh-qa. */
export interface ComputerDriver {
  readonly kind: 'computer'
  readonly platform: 'macos'
  readonly contractVersion: typeof COMPUTER_DRIVER_CONTRACT_VERSION
  observe(request: ComputerObserveRequest, context: ComputerDriverContext): Promise<ComputerObservation>
  visualObserve(request: ComputerVisualObserveRequest, context: ComputerDriverContext): Promise<ComputerVisualCapture>
  act(action: ComputerAction, context: ComputerDriverContext): Promise<ComputerActionReceipt>
  evidence(context: ComputerDriverContext, options?: { limit?: number }): Promise<ComputerEvidence>
  disposeScope(scopeId: string): Promise<void>
  dispose(): Promise<void>
}
