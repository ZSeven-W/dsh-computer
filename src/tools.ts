import type {
  ComputerAction,
  ComputerActionReceipt,
  ComputerDriver,
  ComputerEvidence,
  ComputerObservation,
  ComputerObserveRequest,
  ComputerModifier,
} from './contracts.js'

interface JsonSchema {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  oneOf?: JsonSchema[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean
  items?: JsonSchema
  enum?: Array<string | number | boolean | null>
  const?: string | number | boolean | null
}

export interface StructuralToolRunContext {
  readonly rootCallId?: string
  readonly signal: AbortSignal
  readonly agent?: { readonly id?: unknown }
}

export interface StructuralToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    schema: JsonSchema
    render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>
  }
  readonly timeoutMs?: number
  execute(args: unknown, exec: StructuralToolRunContext): Promise<unknown>
  presentCall?(args: unknown): { card: 'generic'; title: string; kind?: 'read' | 'execute' }
}

const nullable = (schema: JsonSchema): JsonSchema => ({ oneOf: [schema, { type: 'null' }] })
const frameSchema: JsonSchema = {
  oneOf: [
    {
      type: 'object', additionalProperties: false,
      properties: {
        x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' },
      },
      required: ['x', 'y', 'width', 'height'],
    },
    { type: 'null' },
  ],
}
const appSchema: JsonSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    bundleId: { type: 'string' }, pid: { type: 'integer' }, launchIdentity: nullable({ type: 'string' }),
    name: nullable({ type: 'string' }),
  },
  required: ['bundleId', 'pid', 'launchIdentity', 'name'],
}
const windowSchema: JsonSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    number: nullable({ type: 'integer' }), role: { type: 'string' }, subrole: nullable({ type: 'string' }),
    title: nullable({ type: 'string' }), frame: frameSchema, identity: { type: 'string' },
  },
  required: ['number', 'role', 'subrole', 'title', 'frame', 'identity'],
}
const targetSchema: JsonSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    ref: { type: 'string' }, role: { type: 'string' }, subrole: nullable({ type: 'string' }),
    name: nullable({ type: 'string' }), identifier: nullable({ type: 'string' }), frame: frameSchema,
    enabled: nullable({ type: 'boolean' }), focused: nullable({ type: 'boolean' }), secure: { type: 'boolean' },
    actions: { type: 'array', items: { type: 'string' } }, value: nullable({ type: 'string' }), depth: { type: 'integer' },
  },
  required: ['ref', 'role', 'subrole', 'name', 'identifier', 'frame', 'enabled', 'focused', 'secure', 'actions', 'value', 'depth'],
}
const observationSchema: JsonSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    observationId: { type: 'string' }, fingerprint: { type: 'string' }, capturedAt: { type: 'string' },
    expiresAt: { type: 'string' }, app: appSchema, window: windowSchema,
    targets: { type: 'array', items: targetSchema }, truncated: { type: 'boolean' },
    limits: {
      type: 'object', additionalProperties: false,
      properties: { maxDepth: { type: 'integer' }, maxNodes: { type: 'integer' }, ttlMs: { type: 'integer' } },
      required: ['maxDepth', 'maxNodes', 'ttlMs'],
    },
  },
  required: ['observationId', 'fingerprint', 'capturedAt', 'expiresAt', 'app', 'window', 'targets', 'truncated', 'limits'],
}
const postSchema: JsonSchema = {
  oneOf: [
    {
      type: 'object', additionalProperties: false,
      properties: {
        capturedAt: { type: 'string' }, app: appSchema, window: windowSchema,
        target: {
          oneOf: [
            {
              type: 'object', additionalProperties: false,
              properties: {
                role: { type: 'string' }, subrole: nullable({ type: 'string' }), name: nullable({ type: 'string' }),
                identifier: nullable({ type: 'string' }), frame: frameSchema, enabled: nullable({ type: 'boolean' }),
                focused: nullable({ type: 'boolean' }), secure: { type: 'boolean' },
                actions: { type: 'array', items: { type: 'string' } }, value: nullable({ type: 'string' }),
              },
              required: ['role', 'subrole', 'name', 'identifier', 'frame', 'enabled', 'focused', 'secure', 'actions', 'value'],
            },
            { type: 'null' },
          ],
        },
      },
      required: ['capturedAt', 'app', 'window', 'target'],
    },
    { type: 'null' },
  ],
}
const receiptSchema: JsonSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    receiptId: { type: 'string' }, sequence: { type: 'integer' },
    status: { type: 'string', enum: ['confirmed', 'unknown', 'rejected', 'failed'] },
    action: { type: 'string', enum: ['click', 'focus', 'type', 'key'] }, ref: { type: 'string' },
    observationId: nullable({ type: 'string' }), observationFingerprint: nullable({ type: 'string' }),
    startedAt: { type: 'string' }, finishedAt: { type: 'string' }, reason: { type: 'string' },
    nativeAccepted: { type: 'boolean' }, postAction: postSchema,
  },
  required: [
    'receiptId', 'sequence', 'status', 'action', 'ref', 'observationId', 'observationFingerprint',
    'startedAt', 'finishedAt', 'reason', 'nativeAccepted', 'postAction',
  ],
}
const evidenceSchema: JsonSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    contractVersion: { type: 'integer', const: 1 }, scope: { type: 'string' },
    status: {
      type: 'object', additionalProperties: false,
      properties: {
        platform: { type: 'string', enum: ['macos', 'unsupported'] },
        helper: { type: 'string', enum: ['ready', 'not-built', 'unavailable'] },
        accessibilityTrusted: nullable({ type: 'boolean' }), detail: { type: 'string' },
      },
      required: ['platform', 'helper', 'accessibilityTrusted', 'detail'],
    },
    activeObservations: { type: 'integer' }, activeNativeRequests: { type: 'integer' },
    receipts: { type: 'array', items: receiptSchema },
  },
  required: ['contractVersion', 'scope', 'status', 'activeObservations', 'activeNativeRequests', 'receipts'],
}

const renderJson = (_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> => [
  { type: 'text', text: JSON.stringify(value, null, 2) },
]

function record(value: unknown, tool: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${tool}: arguments must be an object`)
  return value as Record<string, unknown>
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function optionalInteger(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (!Number.isInteger(value)) throw new Error(`${key} must be an integer`)
  return value as number
}

function executionContext(exec: StructuralToolRunContext): { scopeId: string; signal: AbortSignal } {
  const agentId = exec.agent?.id
  if (typeof agentId !== 'string' || agentId === '') {
    throw new Error('dsh-computer requires a live Agent identity; agentless calls are rejected')
  }
  return {
    scopeId: agentId,
    signal: exec.signal,
  }
}

function observeRequest(args: Record<string, unknown>): ComputerObserveRequest {
  const bundleId = optionalString(args, 'app_bundle_id')
  const pid = optionalInteger(args, 'app_pid')
  const number = optionalInteger(args, 'window_number')
  const title = optionalString(args, 'window_title')
  const maxDepth = optionalInteger(args, 'max_depth')
  const maxNodes = optionalInteger(args, 'max_nodes')
  const ttlMs = optionalInteger(args, 'ttl_ms')
  return {
    ...((bundleId === undefined && pid === undefined) ? {} : { app: { ...(bundleId === undefined ? {} : { bundleId }), ...(pid === undefined ? {} : { pid }) } }),
    ...((number === undefined && title === undefined) ? {} : { window: { ...(number === undefined ? {} : { number }), ...(title === undefined ? {} : { title }) } }),
    ...(maxDepth === undefined ? {} : { maxDepth }),
    ...(maxNodes === undefined ? {} : { maxNodes }),
    ...(ttlMs === undefined ? {} : { ttlMs }),
  }
}

function actionRequest(args: Record<string, unknown>): ComputerAction {
  const kind = args.action
  const ref = args.ref
  if (typeof ref !== 'string' || ref.trim() === '') throw new Error('computer_act: ref is required')
  if (kind === 'click' || kind === 'focus') return { kind, ref }
  if (kind === 'type') {
    if (typeof args.text !== 'string') throw new Error('computer_act: text is required for type')
    return { kind, ref, text: args.text }
  }
  if (kind === 'key') {
    if (typeof args.key !== 'string') throw new Error('computer_act: key is required for key')
    const modifiers = args.modifiers
    if (modifiers !== undefined && (!Array.isArray(modifiers) || !modifiers.every(item => typeof item === 'string'))) {
      throw new Error('computer_act: modifiers must be an array of strings')
    }
    return {
      kind, ref, key: args.key,
      ...(modifiers === undefined ? {} : { modifiers: modifiers as ComputerModifier[] }),
    }
  }
  throw new Error('computer_act: action must be click, focus, type, or key')
}

export interface ComputerTools {
  computerObserve: StructuralToolDefinition
  computerAct: StructuralToolDefinition
  computerEvidence: StructuralToolDefinition
}

export const COMPUTER_TOOL_NAMES = ['computer_observe', 'computer_act', 'computer_evidence'] as const

export function createComputerTools(driver: ComputerDriver): ComputerTools {
  const computerObserve: StructuralToolDefinition = {
    name: 'computer_observe',
    description: 'Observe one explicit macOS application/window through Accessibility and return bounded, opaque, expiring refs. '
      + 'Omit app selectors only when the current frontmost app is intentionally the target. Run this immediately before every action; '
      + 'refs are Agent-scoped and stale/rebound targets are rejected.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        app_bundle_id: { type: 'string', description: 'Exact bundle identifier. Never use a display name.' },
        app_pid: { type: 'integer', description: 'Exact live PID, optionally paired with bundle identifier.' },
        window_number: { type: 'integer', description: 'Exact AX window number from an earlier observation.' },
        window_title: { type: 'string', description: 'Exact window title; duplicate matches are rejected.' },
        max_depth: { type: 'integer', description: 'Traversal depth, clamped to 1...8.' },
        max_nodes: { type: 'integer', description: 'Node budget, clamped to 1...500.' },
        ttl_ms: { type: 'integer', description: 'Ref lifetime, clamped to 1,000...30,000 ms.' },
      },
      required: [],
    },
    output: { schema: observationSchema, render: renderJson },
    timeoutMs: 120_000,
    async execute(value, exec): Promise<ComputerObservation> {
      return driver.observe(observeRequest(record(value, 'computer_observe')), executionContext(exec))
    },
    presentCall: () => ({ card: 'generic', title: 'Observe macOS window', kind: 'read' }),
  }

  const computerAct: StructuralToolDefinition = {
    name: 'computer_act',
    description: 'Perform one safe click, focus, type, or navigation-key operation using an opaque ref from computer_observe. The driver re-observes '
      + 'the live application, process launch, window and element before acting. Secure text and deterministic destructive, financial, '
      + 'send/publish semantics are blocked by code, regardless of how the model describes the action. Key actions use an explicit navigation '
      + 'allowlist (Tab/Escape/arrows/Home/End/PageUp/PageDown plus documented Shift/Option navigation variants); printable shortcuts and commit '
      + 'keys are rejected. Inspect the returned receipt status: '
      + 'unknown means the input was dispatched but the user-visible effect could not be proven.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['click', 'focus', 'type', 'key'] },
        ref: { type: 'string', description: 'Opaque, expiring ref returned by computer_observe.' },
        text: { type: 'string', description: 'Text for action=type; never use for credentials or secure fields.' },
        key: { type: 'string', description: 'Allowlisted navigation key for action=key. Use type for printable text; Return/Enter are blocked.' },
        modifiers: { type: 'array', items: { type: 'string', enum: ['command', 'control', 'option', 'shift', 'fn'] } },
      },
      required: ['action', 'ref'],
    },
    output: { schema: receiptSchema, render: renderJson },
    timeoutMs: 30_000,
    async execute(value, exec): Promise<ComputerActionReceipt> {
      return driver.act(actionRequest(record(value, 'computer_act')), executionContext(exec))
    },
    presentCall: () => ({ card: 'generic', title: 'Act on macOS target', kind: 'execute' }),
  }

  const computerEvidence: StructuralToolDefinition = {
    name: 'computer_evidence',
    description: 'Report helper/Accessibility readiness plus recent evidence receipts for this Agent only. Receipts distinguish confirmed, '
      + 'unknown, rejected and failed outcomes; no raw Agent id or actionable native locator is exposed.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        limit: { type: 'integer', description: 'Most recent receipts, clamped to 1...100.' },
      },
      required: [],
    },
    output: { schema: evidenceSchema, render: renderJson },
    timeoutMs: 120_000,
    async execute(value, exec): Promise<ComputerEvidence> {
      const args = record(value, 'computer_evidence')
      const limit = optionalInteger(args, 'limit')
      return driver.evidence(executionContext(exec), limit === undefined ? {} : { limit })
    },
    presentCall: () => ({ card: 'generic', title: 'Inspect Computer Use evidence', kind: 'read' }),
  }

  return { computerObserve, computerAct, computerEvidence }
}
