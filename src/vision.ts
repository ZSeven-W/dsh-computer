import type { ComputerFrame, ComputerVisualCapture } from './contracts.js'

export type ComputerImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** Plain durable attachment reference accepted by DSH image content blocks. */
export interface ComputerImageRef {
  attachmentId: string
  mediaType: ComputerImageMediaType
  bytes: number
  width: number
  height: number
  name?: string
  originalDimensions?: {
    width: number
    height: number
  }
}

export interface StructuralAttachmentStore {
  saveImage(input: {
    data: Uint8Array
    mediaType: 'image/png'
    name?: string
  }): Promise<ComputerImageRef>
}

export interface StructuralLlmService {
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{
    inputModalities?: readonly string[]
  }>
}

export interface VisualToolExecution {
  readonly signal?: AbortSignal
  readonly agent?: {
    readonly session?: {
      requestHeader?(): { config?: { provider?: string; model?: string } } | undefined
    }
    readonly options?: { provider?: string; model?: string }
  }
}

export interface VisualServiceSource {
  getService?(name: 'attachments' | 'llm'): unknown
}

export interface ComputerVisualToolMark {
  number: number
  ref: string
  sourceIndex: number
  nativePixelFrame: ComputerFrame
  attachmentPixelFrame: ComputerFrame
}

export interface ComputerVisualToolValue {
  observationId: string
  observationFingerprint: string
  capturedAt: string
  expiresAt: string
  app: ComputerVisualCapture['app']
  window: ComputerVisualCapture['window']
  image: ComputerImageRef
  capture: {
    artifact: ComputerVisualCapture['capture']['artifact']
    pointFrame: ComputerFrame
    nativePixels: { width: number; height: number }
    attachmentPixels: { width: number; height: number }
    /** Multiplier from native-capture pixel coordinates to delivered-attachment pixels. */
    attachmentScale: { x: number; y: number }
    /** Multiplier from global macOS points to native-capture pixels. */
    pointToNativeScale: { x: number; y: number }
    quality: ComputerVisualCapture['capture']['quality']
  }
  marks: ComputerVisualToolMark[]
  omitted: ComputerVisualCapture['omitted']
  note: string
}

export type ComputerVisualContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; attachment: ComputerImageRef }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isAbortError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError'
}

/** Preserve AbortSignal.reason (or an upstream AbortError) across structural host seams. */
export function throwIfVisualAborted(signal: AbortSignal | undefined, error?: unknown): void {
  if (signal?.aborted === true) signal.throwIfAborted()
  if (error !== undefined && isAbortError(error)) throw error
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || Object.is(value, -0)) {
    throw new Error(`computer_visual_observe: attachment ${field} must be a positive safe integer`)
  }
  return value as number
}

function lossless(value: number): number {
  if (!Number.isFinite(value)) throw new Error('computer_visual_observe: calculated image scale is not finite')
  return value === 0 ? 0 : value
}

function scaledFrame(frame: ComputerFrame, x: number, y: number): ComputerFrame {
  return {
    x: lossless(frame.x * x),
    y: lossless(frame.y * y),
    width: lossless(frame.width * x),
    height: lossless(frame.height * y),
  }
}

function imageRef(value: unknown): ComputerImageRef {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('computer_visual_observe: attachment service returned no image reference')
  }
  const ref = value as Record<string, unknown>
  if (!nonEmpty(ref.attachmentId)) {
    throw new Error('computer_visual_observe: attachment service returned an invalid attachmentId')
  }
  if (ref.mediaType !== 'image/png' && ref.mediaType !== 'image/jpeg'
    && ref.mediaType !== 'image/webp' && ref.mediaType !== 'image/gif') {
    throw new Error('computer_visual_observe: attachment service returned an unsupported image mediaType')
  }
  const original = ref.originalDimensions
  let originalDimensions: ComputerImageRef['originalDimensions'] | undefined
  if (original !== undefined) {
    if (original === null || typeof original !== 'object' || Array.isArray(original)) {
      throw new Error('computer_visual_observe: attachment originalDimensions is invalid')
    }
    const dimensions = original as Record<string, unknown>
    originalDimensions = {
      width: positiveSafeInteger(dimensions.width, 'originalDimensions.width'),
      height: positiveSafeInteger(dimensions.height, 'originalDimensions.height'),
    }
  }
  if (ref.name !== undefined && typeof ref.name !== 'string') {
    throw new Error('computer_visual_observe: attachment name must be a string')
  }
  return {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: positiveSafeInteger(ref.bytes, 'bytes'),
    width: positiveSafeInteger(ref.width, 'width'),
    height: positiveSafeInteger(ref.height, 'height'),
    ...(ref.name === undefined ? {} : { name: ref.name }),
    ...(originalDimensions === undefined ? {} : { originalDimensions }),
  }
}

/**
 * Lazily resolve both host services and strictly gate the exact active model
 * route. This must run before any native capture or attachment write.
 */
export async function requireImageCapableRoute(
  source: VisualServiceSource,
  exec: VisualToolExecution,
): Promise<StructuralAttachmentStore> {
  throwIfVisualAborted(exec.signal)
  const attachments = source.getService?.('attachments') as StructuralAttachmentStore | undefined
  const llm = source.getService?.('llm') as StructuralLlmService | undefined
  if (attachments === undefined || typeof attachments.saveImage !== 'function') {
    throw new Error('computer_visual_observe requires DSH\'s attachment service, but none is mounted')
  }
  if (llm === undefined || typeof llm.resolveModelInfo !== 'function') {
    throw new Error('computer_visual_observe requires DSH\'s LLM route service, but none is mounted')
  }

  let routed: { config?: { provider?: string; model?: string } } | undefined
  try {
    routed = exec.agent?.session?.requestHeader?.()
  } catch (error) {
    throwIfVisualAborted(exec.signal, error)
    throw new Error(`computer_visual_observe could not inspect the current model route: ${errorMessage(error)}`)
  }
  const provider = routed?.config?.provider ?? exec.agent?.options?.provider
  const model = routed?.config?.model ?? exec.agent?.options?.model
  if (!nonEmpty(provider) || !nonEmpty(model)) {
    throw new Error('computer_visual_observe could not resolve the exact current provider/model route')
  }

  let info: { inputModalities?: readonly string[] }
  try {
    info = await llm.resolveModelInfo(provider, model, exec.signal)
  } catch (error) {
    throwIfVisualAborted(exec.signal, error)
    throw new Error(
      `computer_visual_observe could not resolve model "${model}" on provider "${provider}": ${errorMessage(error)}`,
    )
  }
  throwIfVisualAborted(exec.signal)
  if (info.inputModalities?.includes('image') !== true) {
    throw new Error(
      `computer_visual_observe cannot capture for model "${model}": the exact current route does not declare image input; switch to an image-capable model`,
    )
  }
  return attachments
}

/** Persist the verified native PNG and project a lossless, model-facing JSON value. */
export async function commitVisualCapture(
  attachments: StructuralAttachmentStore,
  captured: ComputerVisualCapture,
  signal?: AbortSignal,
): Promise<ComputerVisualToolValue> {
  throwIfVisualAborted(signal)
  let stored: ComputerImageRef
  try {
    stored = imageRef(await attachments.saveImage({
      data: captured.png,
      mediaType: 'image/png',
      name: 'dsh-computer-window.png',
    }))
  } catch (error) {
    throwIfVisualAborted(signal, error)
    throw new Error(`computer_visual_observe could not persist the captured image: ${errorMessage(error)}`)
  }
  // saveImage is not cancellable, but a late cancellation must keep the
  // durable object out of the tool-result/history even if storage completed.
  throwIfVisualAborted(signal)

  const attachmentScaleX = lossless(stored.width / captured.capture.pixelWidth)
  const attachmentScaleY = lossless(stored.height / captured.capture.pixelHeight)
  return {
    observationId: captured.observationId,
    observationFingerprint: captured.observationFingerprint,
    capturedAt: captured.capturedAt,
    expiresAt: captured.expiresAt,
    app: structuredClone(captured.app),
    window: structuredClone(captured.window),
    image: stored,
    capture: {
      artifact: structuredClone(captured.capture.artifact),
      pointFrame: structuredClone(captured.capture.pointFrame),
      nativePixels: { width: captured.capture.pixelWidth, height: captured.capture.pixelHeight },
      attachmentPixels: { width: stored.width, height: stored.height },
      attachmentScale: { x: attachmentScaleX, y: attachmentScaleY },
      pointToNativeScale: { x: captured.capture.scaleX, y: captured.capture.scaleY },
      quality: structuredClone(captured.capture.quality),
    },
    marks: captured.marks.map(mark => ({
      number: mark.number,
      ref: mark.ref,
      sourceIndex: mark.sourceIndex,
      nativePixelFrame: structuredClone(mark.nativePixelFrame),
      attachmentPixelFrame: scaledFrame(mark.nativePixelFrame, attachmentScaleX, attachmentScaleY),
    })),
    omitted: captured.omitted.map(omission => ({ ...omission })),
    note: 'Set-of-Mark numbers are baked into the attached image. DSH may normalize or downscale the attachment; use attachmentPixelFrame for delivered-image pixels and the opaque ref for later actions.',
  }
}

/** Pure projection used by normal and replayed tool results. */
export function renderVisualObservation(
  _args: unknown,
  value: ComputerVisualToolValue,
): ComputerVisualContentBlock[] {
  return [
    { type: 'text', text: JSON.stringify(value, null, 2) },
    { type: 'image', attachment: value.image },
  ]
}
