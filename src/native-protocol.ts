import type {
  ComputerActionStatus,
  ComputerAppIdentity,
  ComputerAppSelector,
  ComputerFrame,
  ComputerModifier,
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

export interface NativeExpectedTarget {
  app: ComputerAppIdentity
  window: ComputerWindowIdentity
  element: NativeElementIdentity
  locator: number[]
}

export type NativeActionPayload =
  | { kind: 'click' }
  | { kind: 'focus' }
  | { kind: 'type'; text: string }
  | { kind: 'key'; key: string; modifiers: ComputerModifier[] }

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
    }

export interface NativeStatusResult {
  platform: 'macos'
  accessibilityTrusted: boolean
  helperVersion: string
}

export interface NativeResponse {
  id: string
  ok: boolean
  result?: NativeStatusResult | NativeObserveResult | NativeActionResult
  error?: {
    code: string
    message: string
  }
}

export interface NativeTransport {
  request<T extends NativeStatusResult | NativeObserveResult | NativeActionResult>(
    request: NativeRequest,
    options: { scopeId: string; signal?: AbortSignal },
  ): Promise<T>
  active(scopeId: string): number
  disposeScope(scopeId: string): Promise<void>
  dispose(): Promise<void>
}
