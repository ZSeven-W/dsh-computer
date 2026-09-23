import type {
  ComputerActionStatus,
  ComputerAppIdentity,
  ComputerAppSelector,
  ComputerFrame,
  ComputerModifier,
  ComputerRunningApp,
  ComputerScrollAmount,
  ComputerScrollDirection,
  ComputerWindowIdentity,
  ComputerWindowSelector,
} from './contracts.js'

export interface NativeElementIdentity {
  role: string
  subrole: string | null
  name: string | null
  identifier: string | null
  frame: ComputerFrame | null
  enabled: boolean | null
  focused: boolean | null
  secure: boolean
  actions: string[]
  value: string | null
}

export interface NativeObservedNode extends NativeElementIdentity {
  locator: number[]
  depth: number
}

export interface NativeObserveResult {
  capturedAt: string
  app: ComputerAppIdentity
  window: ComputerWindowIdentity
  nodes: NativeObservedNode[]
  truncated: boolean
}

export type NativeCapturableWindowIdentity = Omit<ComputerWindowIdentity, 'number' | 'frame'> & {
  number: number
  frame: ComputerFrame
}

export interface NativeCaptureTarget {
  /** Opaque, Agent-private reference minted by the controller. */
  ref: string
  /** Stable index in the source Accessibility observation. */
  index: number
  element: NativeElementIdentity
  locator: number[]
}

export interface NativeCaptureInput {
  app: ComputerAppIdentity
  window: NativeCapturableWindowIdentity
  targets: NativeCaptureTarget[]
  /** Created by capture-native.ts; never accepted from model/tool arguments. */
  outputPath: string
}

export interface NativeCaptureQuality {
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

export interface NativeCaptureMark {
  number: number
  ref: string
  index: number
  /** Top-origin pixel coordinates in the returned PNG. */
  pixelFrame: ComputerFrame
}

export interface NativeCaptureOmission {
  ref: string
  index: number
  reason: string
}

export interface NativeCaptureResult {
  capturedAt: string
  app: ComputerAppIdentity
  window: NativeCapturableWindowIdentity
  artifact: {
    format: 'png'
    byteLength: number
    sha256: string
  }
  /** Global Accessibility coordinates, measured in points. */
  pointFrame: ComputerFrame
  pixelWidth: number
  pixelHeight: number
  scaleX: number
  scaleY: number
  quality: NativeCaptureQuality
  /** Number-to-ref/index mapping for the visible Set-of-Mark overlay. */
  marks: NativeCaptureMark[]
  omitted: NativeCaptureOmission[]
}

export interface NativeExpectedTarget {
  app: ComputerAppIdentity
  window: ComputerWindowIdentity
  element: NativeElementIdentity
  locator: number[]
}

/** Host-minted, single-request grant. Never accepted from tool arguments. */
export interface NativeApprovalGrant {
  outcome: 'allowed-once'
  observationId: string
  refDigest: string
  riskCode: 'dangerous-click' | 'commit-key' | 'unsafe-key-chord' | 'visual-point-action'
  observationFingerprint: string
  actionDigest: string
  nonce: string
}

export type NativeActionPayload =
  | { kind: 'click' }
  | { kind: 'focus' }
  | { kind: 'type'; text: string }
  | { kind: 'key'; key: string; modifiers: ComputerModifier[] }
  | { kind: 'scroll'; direction: ComputerScrollDirection; amount: ComputerScrollAmount }

/** Native-image pixel coordinate (top-origin, integer) inside the captured window. */
export interface NativeVisualPoint {
  x: number
  y: number
}

export type NativeVisualActionPayload =
  | { op: 'click'; point: NativeVisualPoint }
  | { op: 'drag'; point: NativeVisualPoint; to: NativeVisualPoint }
  | { op: 'scroll'; point: NativeVisualPoint; direction: ComputerScrollDirection; amount: ComputerScrollAmount }

export interface NativeVisualActInput {
  app: ComputerAppIdentity
  window: NativeCapturableWindowIdentity
  captureSha256: string
  /** Original SoM targets, re-sent so the helper can re-render an identical overlay and compare its SHA-256. */
  targets: NativeCaptureTarget[]
  action: NativeVisualActionPayload
  approval: NativeApprovalGrant | null
}

export interface NativeVisualActResult {
  status: ComputerActionStatus
  reason: string
  accepted: boolean
  post: {
    capturedAt: string
    app: ComputerAppIdentity
    window: ComputerWindowIdentity
    target: NativeElementIdentity | null
  } | null
}

export interface NativeActionResult {
  status: ComputerActionStatus
  reason: string
  accepted: boolean
  post: {
    capturedAt: string
    app: ComputerAppIdentity
    window: ComputerWindowIdentity
    target: NativeElementIdentity | null
  } | null
}

export type NativeHelperResolutionSource =
  | 'explicit-override'
  | 'installed-app'
  | 'worktree-build'
  | 'cache-build'

export interface NativeHelperBundleIdentity {
  path: string | null
  identifier: string | null
  version: string | null
}

export interface NativeHelperSigningMetadata {
  signed: boolean
  kind: 'development' | 'developer-id' | 'distribution' | 'other' | 'adhoc' | 'unsigned'
  codeIdentifier: string | null
  teamIdentifier: string | null
  authorities: string[]
  cdhash: string | null
  statusCode: number
  detail: string | null
}

export interface NativeHelperProcessIdentity {
  pid: number
  ppid: number
}

/** Immediate process that launched the short-lived Helper (normally DSH's Node host). */
export interface NativeHelperCallerContext {
  pid: number
  executable: string | null
  bundleIdentifier: string | null
  name: string | null
}

export type NativeRequest =
  | {
      id: string
      command: 'status'
    }
  | {
      id: string
      command: 'observe'
      app: ComputerAppSelector | null
      window: ComputerWindowSelector | null
      maxDepth: number
      maxNodes: number
    }
  | {
      id: string
      command: 'act'
      expected: NativeExpectedTarget
      action: NativeActionPayload
      approval: NativeApprovalGrant | null
    }
  | {
      id: string
      command: 'capture'
      capture: NativeCaptureInput
    }
  | {
      id: string
      command: 'visual-act'
      visual: NativeVisualActInput
    }
  | {
      id: string
      command: 'apps'
    }
  | {
      id: string
      command: 'launch'
      launch: { bundleId: string }
    }

export interface NativeAppsResult {
  apps: ComputerRunningApp[]
  truncated: boolean
  accessibilityTrusted: boolean
}

export interface NativeLaunchResult {
  launched: boolean
  app: ComputerRunningApp
}

export interface NativeStatusResult {
  platform: 'macos'
  accessibilityTrusted: boolean
  screenRecordingTrusted: boolean
  /** Positive evidence that the console session is locked or inactive. */
  sessionLocked: boolean
  /** False for a known lock and for indeterminate/non-console session state. */
  interactiveSessionAvailable: boolean
  helperVersion: string
  helperExecutable: string
  bundle: NativeHelperBundleIdentity
  signing: NativeHelperSigningMetadata
  process: NativeHelperProcessIdentity
  caller: NativeHelperCallerContext
  resolution: {
    source: NativeHelperResolutionSource
    selectedPath: string
  }
  /** True only when the resolver validated the fixed app path, owner, bundle id, and non-ad-hoc signature. */
  identityStable: boolean
}

export interface NativeResponse {
  id: string
  ok: boolean
  result?: NativeStatusResult | NativeObserveResult | NativeActionResult | NativeCaptureResult | NativeVisualActResult | NativeAppsResult | NativeLaunchResult
  error?: {
    code: string
    message: string
  }
}

export interface NativeTransport {
  request<T extends NativeStatusResult | NativeObserveResult | NativeActionResult | NativeCaptureResult | NativeVisualActResult | NativeAppsResult | NativeLaunchResult>(
    request: NativeRequest,
    options: { scopeId: string; signal?: AbortSignal },
  ): Promise<T>
  active(scopeId: string): number
  disposeScope(scopeId: string): Promise<void>
  dispose(): Promise<void>
}
