import type {
  ComputerAction,
  ComputerActionReceipt,
  ComputerApprovalOutcome,
  ComputerDriver,
  ComputerDriverContext,
  ComputerEvidence,
  ComputerObservation,
  ComputerObserveRequest,
  ComputerModifier,
  ComputerScrollAmount,
} from './contracts.js'
import {
  commitVisualCapture,
  renderVisualObservation,
  requireImageCapableRoute,
  throwIfVisualAborted,
  type ComputerVisualContentBlock,
  type ComputerVisualToolValue,
} from './vision.js'

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
  readonly callId?: unknown
  readonly rootCallId?: string
  readonly signal: AbortSignal
  readonly agent?: object & {
    readonly id?: unknown
    readonly session?: {
      requestHeader?(): { config?: { provider?: string; model?: string } } | undefined
    }
    readonly options?: { provider?: string; model?: string }
  }
}

/** Structural seam for the optional host service; no host package is imported. */
export interface StructuralApprovalService {
  request(input: {
    readonly agent: object
    readonly toolName: string
    readonly callId?: string
    readonly reason?: string
    readonly signal?: AbortSignal
  }): Promise<ComputerApprovalOutcome>
}

export interface ComputerToolHost {
  /** Called only after deterministic policy says the current action needs approval. */
  getApproval?(): StructuralApprovalService | undefined
  /** Called inside each visual execution; services may mount or change after plugin activation. */
  getService?(name: 'attachments' | 'llm'): unknown
}

export interface StructuralToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    schema: JsonSchema
    render(args: unknown, value: unknown): ComputerVisualContentBlock[]
  }
  readonly timeoutMs?: number
  execute(args: unknown, exec: StructuralToolRunContext): Promise<unknown>
  presentCall?(args: unknown): { card: 'generic'; title: string; kind?: 'read' | 'execute' }
}

const nullable = (schema: JsonSchema): JsonSchema => ({ oneOf: [schema, { type: 'null' }] })
const concreteFrameSchema: JsonSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' },
  },
  required: ['x', 'y', 'width', 'height'],
}
const frameSchema: JsonSchema = {
  oneOf: [
    concreteFrameSchema,
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
    action: { type: 'string', enum: ['click', 'focus', 'type', 'key', 'scroll'] }, ref: { type: 'string' },
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
    contractVersion: { type: 'integer', const: 4 }, scope: { type: 'string' },
    status: {
      type: 'object', additionalProperties: false,
      properties: {
        platform: { type: 'string', enum: ['macos', 'unsupported'] },
        helper: { type: 'string', enum: ['ready', 'not-built', 'unavailable'] },
        accessibilityTrusted: nullable({ type: 'boolean' }),
        screenRecordingTrusted: nullable({ type: 'boolean' }),
        sessionLocked: nullable({ type: 'boolean' }),
        interactiveSessionAvailable: nullable({ type: 'boolean' }),
        helperVersion: nullable({ type: 'string' }),
        helperExecutable: nullable({ type: 'string' }),
        bundle: nullable({
          type: 'object', additionalProperties: false,
          properties: {
            path: nullable({ type: 'string' }), identifier: nullable({ type: 'string' }), version: nullable({ type: 'string' }),
          },
          required: ['path', 'identifier', 'version'],
        }),
        signing: nullable({
          type: 'object', additionalProperties: false,
          properties: {
            signed: { type: 'boolean' },
            kind: { type: 'string', enum: ['development', 'developer-id', 'distribution', 'other', 'adhoc', 'unsigned'] },
            codeIdentifier: nullable({ type: 'string' }), teamIdentifier: nullable({ type: 'string' }),
            authorities: { type: 'array', items: { type: 'string' } }, cdhash: nullable({ type: 'string' }),
            statusCode: { type: 'integer' }, detail: nullable({ type: 'string' }),
          },
          required: ['signed', 'kind', 'codeIdentifier', 'teamIdentifier', 'authorities', 'cdhash', 'statusCode', 'detail'],
        }),
        process: nullable({
          type: 'object', additionalProperties: false,
          properties: { pid: { type: 'integer' }, ppid: { type: 'integer' } },
          required: ['pid', 'ppid'],
        }),
        caller: nullable({
          type: 'object', additionalProperties: false,
          properties: {
            pid: { type: 'integer' }, executable: nullable({ type: 'string' }),
            bundleIdentifier: nullable({ type: 'string' }), name: nullable({ type: 'string' }),
          },
          required: ['pid', 'executable', 'bundleIdentifier', 'name'],
        }),
        resolution: nullable({
          type: 'object', additionalProperties: false,
          properties: {
            source: { type: 'string', enum: ['explicit-override', 'installed-app', 'worktree-build', 'cache-build'] },
            selectedPath: { type: 'string' },
          },
          required: ['source', 'selectedPath'],
        }),
        identityStable: nullable({ type: 'boolean' }),
        detail: { type: 'string' },
      },
      required: [
        'platform', 'helper', 'accessibilityTrusted', 'screenRecordingTrusted', 'sessionLocked',
        'interactiveSessionAvailable', 'helperVersion',
        'helperExecutable', 'bundle', 'signing', 'process', 'caller', 'resolution', 'identityStable', 'detail',
      ],
    },
    activeObservations: { type: 'integer' }, activeNativeRequests: { type: 'integer' },
    receipts: { type: 'array', items: receiptSchema },
    receipts_total: { type: 'integer' }, receipts_dropped: { type: 'integer' },
    receipts_returned: { type: 'integer' }, bounded: { type: 'boolean', const: true },
  },
  required: [
    'contractVersion', 'scope', 'status', 'activeObservations', 'activeNativeRequests',
    'receipts', 'receipts_total', 'receipts_dropped', 'receipts_returned', 'bounded',
  ],
}

const imageRefSchema: JsonSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    bytes: { type: 'integer' }, width: { type: 'integer' }, height: { type: 'integer' }, name: { type: 'string' },
    originalDimensions: {
      type: 'object', additionalProperties: false,
      properties: { width: { type: 'integer' }, height: { type: 'integer' } },
      required: ['width', 'height'],
    },
  },
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
}

const qualitySchema: JsonSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    classification: {
      type: 'string',
      enum: ['usable', 'transparent', 'mostly-transparent', 'near-black', 'near-white', 'near-uniform'],
    },
    usable: { type: 'boolean' }, sampleCount: { type: 'integer' }, visibleFraction: { type: 'number' },
    meanLuminance: { type: 'number' }, luminanceVariance: { type: 'number' }, luminanceRange: { type: 'number' },
    darkFraction: { type: 'number' }, lightFraction: { type: 'number' }, distinctColorBuckets: { type: 'integer' },
  },
  required: [
    'classification', 'usable', 'sampleCount', 'visibleFraction', 'meanLuminance', 'luminanceVariance',
    'luminanceRange', 'darkFraction', 'lightFraction', 'distinctColorBuckets',
  ],
}

const visualValueSchema: JsonSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    observationId: { type: 'string' }, observationFingerprint: { type: 'string' },
    capturedAt: { type: 'string' }, expiresAt: { type: 'string' }, app: appSchema,
    window: {
      type: 'object', additionalProperties: false,
      properties: {
        number: { type: 'integer' }, role: { type: 'string' }, subrole: nullable({ type: 'string' }),
        title: nullable({ type: 'string' }), frame: concreteFrameSchema, identity: { type: 'string' },
      },
      required: ['number', 'role', 'subrole', 'title', 'frame', 'identity'],
    },
    image: imageRefSchema,
    capture: {
      type: 'object', additionalProperties: false,
      properties: {
        artifact: {
          type: 'object', additionalProperties: false,
          properties: { format: { type: 'string', const: 'png' }, byteLength: { type: 'integer' }, sha256: { type: 'string' } },
          required: ['format', 'byteLength', 'sha256'],
        },
        pointFrame: concreteFrameSchema,
        nativePixels: {
          type: 'object', additionalProperties: false,
          properties: { width: { type: 'integer' }, height: { type: 'integer' } }, required: ['width', 'height'],
        },
        attachmentPixels: {
          type: 'object', additionalProperties: false,
          properties: { width: { type: 'integer' }, height: { type: 'integer' } }, required: ['width', 'height'],
        },
        attachmentScale: {
          type: 'object', additionalProperties: false,
          properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'],
        },
        pointToNativeScale: {
          type: 'object', additionalProperties: false,
          properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'],
        },
        quality: qualitySchema,
      },
      required: [
        'artifact', 'pointFrame', 'nativePixels', 'attachmentPixels', 'attachmentScale',
        'pointToNativeScale', 'quality',
      ],
    },
    marks: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        properties: {
          number: { type: 'integer' }, ref: { type: 'string' }, sourceIndex: { type: 'integer' },
          nativePixelFrame: concreteFrameSchema, attachmentPixelFrame: concreteFrameSchema,
        },
        required: ['number', 'ref', 'sourceIndex', 'nativePixelFrame', 'attachmentPixelFrame'],
      },
    },
    omitted: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        properties: { ref: { type: 'string' }, sourceIndex: { type: 'integer' }, reason: { type: 'string' } },
        required: ['ref', 'sourceIndex', 'reason'],
      },
    },
    note: { type: 'string' },
  },
  required: [
    'observationId', 'observationFingerprint', 'capturedAt', 'expiresAt', 'app', 'window', 'image',
    'capture', 'marks', 'omitted', 'note',
  ],
}

const renderJson = (_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> => [
  { type: 'text', text: JSON.stringify(value, null, 2) },
]

function record(value: unknown, tool: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${tool}: arguments must be an object`)
  return value as Record<string, unknown>
}

function assertOnlyKeys(args: Record<string, unknown>, allowed: readonly string[], tool: string): void {
  const accepted = new Set(allowed)
  const unexpected = Object.keys(args).find(key => !accepted.has(key))
  if (unexpected !== undefined) throw new Error(`${tool}: unexpected argument ${unexpected}`)
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

function executionContext(exec: StructuralToolRunContext): ComputerDriverContext {
  const agentId = exec.agent?.id
  if (typeof agentId !== 'string' || agentId === '') {
    throw new Error('dsh-computer requires a live Agent identity; agentless calls are rejected')
  }
  return {
    scopeId: agentId,
    signal: exec.signal,
  }
}

function actionExecutionContext(exec: StructuralToolRunContext, host: ComputerToolHost): ComputerDriverContext {
  const base = executionContext(exec)
  const agent = exec.agent as object & { readonly id?: unknown }
  if (host.getApproval === undefined) return base
  return {
    ...base,
    approval: {
      async request(reason): Promise<ComputerApprovalOutcome> {
        const callId = exec.callId
        if (typeof callId !== 'string' || callId === '') return 'unavailable'
        const approval = host.getApproval?.()
        if (approval === undefined || typeof approval.request !== 'function') return 'unavailable'
        const outcome = await approval.request({
          agent,
          toolName: 'computer_act',
          callId,
          reason,
          signal: exec.signal,
        })
        return outcome === 'allowed-once' || outcome === 'rejected' || outcome === 'cancelled' || outcome === 'unavailable'
          ? outcome
          : 'unavailable'
      },
    },
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
  if (kind === 'scroll') {
    const direction = args.direction
    if (direction !== 'up' && direction !== 'down') {
      throw new Error('computer_act: direction is required for scroll and must be up or down')
    }
    const amount = args.amount
    if (amount !== undefined && amount !== 'line' && amount !== 'page'
      && (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0)) {
      throw new Error('computer_act: amount must be line, page, or a positive number of points')
    }
    if (amount === undefined) return { kind, ref, direction }
    return { kind, ref, direction, amount: amount as ComputerScrollAmount }
  }
  throw new Error('computer_act: action must be click, focus, type, key, or scroll')
}

export interface ComputerTools {
  computerObserve: StructuralToolDefinition
  computerVisualObserve: StructuralToolDefinition
  computerAct: StructuralToolDefinition
  computerEvidence: StructuralToolDefinition
}

export const COMPUTER_TOOL_NAMES = [
  'computer_observe', 'computer_visual_observe', 'computer_act', 'computer_evidence',
] as const

export function createComputerTools(driver: ComputerDriver, host: ComputerToolHost = {}): ComputerTools {
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
      const args = record(value, 'computer_observe')
      assertOnlyKeys(args, [
        'app_bundle_id', 'app_pid', 'window_number', 'window_title',
        'max_depth', 'max_nodes', 'ttl_ms',
      ], 'computer_observe')
      return driver.observe(observeRequest(args), executionContext(exec))
    },
    presentCall: () => ({ card: 'generic', title: 'Observe macOS window', kind: 'read' }),
  }

  const computerVisualObserve: StructuralToolDefinition = {
    name: 'computer_visual_observe',
    description: 'Capture the exact numbered macOS window bound to an unexpired computer_observe result in this Agent scope, overlay bounded '
      + 'Set-of-Mark labels for AX targets, persist the verified image through DSH attachments, and return the image to the current model. '
      + 'This dedicated visual path requires the exact active provider/model route to declare image input. It never accepts a path, window, '
      + 'application, coordinate, ref, or approval from model arguments; visual observation is read-only and does not consume action refs.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        observation_id: { type: 'string', description: 'Opaque observation id from computer_observe in this Agent scope.' },
        max_marks: { type: 'integer', description: 'Set-of-Mark budget, clamped to 1...200; defaults to 80.' },
      },
      required: ['observation_id'],
    },
    output: { schema: visualValueSchema, render: renderVisualObservation as StructuralToolDefinition['output']['render'] },
    timeoutMs: 120_000,
    async execute(value, exec): Promise<ComputerVisualToolValue> {
      const args = record(value, 'computer_visual_observe')
      assertOnlyKeys(args, ['observation_id', 'max_marks'], 'computer_visual_observe')
      const observationId = args.observation_id
      if (typeof observationId !== 'string' || observationId.trim() === '') {
        throw new Error('computer_visual_observe: observation_id is required')
      }
      const maxMarks = optionalInteger(args, 'max_marks')
      // Strict route gate precedes driver capture and attachment I/O.
      const attachments = await requireImageCapableRoute(host, exec)
      throwIfVisualAborted(exec.signal)
      const captured = await driver.visualObserve({
        observationId,
        ...(maxMarks === undefined ? {} : { maxMarks }),
      }, executionContext(exec))
      throwIfVisualAborted(exec.signal)
      return commitVisualCapture(attachments, captured, exec.signal)
    },
    presentCall: () => ({ card: 'generic', title: 'Visually observe macOS window', kind: 'read' }),
  }

  const computerAct: StructuralToolDefinition = {
    name: 'computer_act',
    description: 'Perform one click, focus, type, key, or scroll operation using an opaque ref from computer_observe. The driver read-only re-observes '
      + 'the live application, process launch, window and element before acting, and repeats that preflight after any approval. Secure text is '
      + 'permanently blocked. Destructive/financial/send/publish clicks, commit keys, and non-navigation key chords require host-owned approval '
      + 'for exactly this action/ref/observation; the model cannot provide an approval or risk flag. Safe focus, allowlisted navigation, and scrolling do not prompt. '
      + 'Scroll (action=scroll) scrolls the Accessibility scroll area that contains or is the referenced element, direction up/down with an optional '
      + 'amount of line, page (default), or a positive point count. '
      + 'Inspect the returned receipt status: '
      + 'unknown means the input was dispatched but the user-visible effect could not be proven — for scroll, re-observe to decide whether content moved.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['click', 'focus', 'type', 'key', 'scroll'] },
        ref: { type: 'string', description: 'Opaque, expiring ref returned by computer_observe.' },
        text: { type: 'string', description: 'Text for action=type; never use for credentials or secure fields.' },
        key: { type: 'string', description: 'Key name for action=key. Allowlisted navigation is immediate; commit and non-navigation keys require host approval.' },
        modifiers: { type: 'array', items: { type: 'string', enum: ['command', 'control', 'option', 'shift', 'fn'] } },
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction for action=scroll.' },
        amount: { description: 'Scroll amount for action=scroll: line, page (default), or a positive point count.', oneOf: [{ type: 'string', enum: ['line', 'page'] }, { type: 'number' }] },
      },
      required: ['action', 'ref'],
    },
    output: { schema: receiptSchema, render: renderJson },
    timeoutMs: 30_000,
    async execute(value, exec): Promise<ComputerActionReceipt> {
      const args = record(value, 'computer_act')
      assertOnlyKeys(args, ['action', 'ref', 'text', 'key', 'modifiers', 'direction', 'amount'], 'computer_act')
      return driver.act(actionRequest(args), actionExecutionContext(exec, host))
    },
    presentCall: () => ({ card: 'generic', title: 'Act on macOS target', kind: 'execute' }),
  }

  const computerEvidence: StructuralToolDefinition = {
    name: 'computer_evidence',
    description: 'Report helper/Accessibility readiness plus recent evidence receipts for this Agent only. Receipts distinguish confirmed, '
      + 'unknown, rejected and failed outcomes; no raw Agent id or actionable native locator is exposed. The receipt ring is bounded: '
      + 'receipts_total is every receipt ever recorded in this scope, receipts_dropped is how many were evicted from the ring, '
      + 'receipts_returned is how many this call actually returned (bounded by limit), and bounded is always true.',
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
      assertOnlyKeys(args, ['limit'], 'computer_evidence')
      const limit = optionalInteger(args, 'limit')
      return driver.evidence(executionContext(exec), limit === undefined ? {} : { limit })
    },
    presentCall: () => ({ card: 'generic', title: 'Inspect Computer Use evidence', kind: 'read' }),
  }

  return { computerObserve, computerVisualObserve, computerAct, computerEvidence }
}
