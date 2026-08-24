import { createHash, randomBytes } from 'node:crypto'
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type {
  NativeActionResult,
  NativeCaptureResult,
  NativeObserveResult,
  NativeRequest,
  NativeResponse,
  NativeHelperResolutionSource,
  NativeStatusResult,
  NativeTransport,
} from './native-protocol.js'

const MAX_HELPER_OUTPUT_BYTES = 4 * 1024 * 1024
const HELPER_TIMEOUT_MS = 20_000
const BUILD_TIMEOUT_MS = 180_000
const SIGNATURE_TIMEOUT_MS = 20_000
const HELPER_PROTOCOL_VERSION = '0.1.0-rc.1'
const STABLE_HELPER_BUNDLE_ID = 'io.github.zseven-w.dsh-computer.helper'
const DEVELOPMENT_HELPER_CODE_ID = 'io.github.zseven-w.dsh-computer.development-helper'
const STABLE_HELPER_APP_NAME = 'DSH Computer Helper.app'
const HELPER_EXECUTABLE_NAME = 'dsh-computer-helper'

function defaultStableBinaryPath(): string {
  return join(
    homedir(), 'Library', 'Application Support', 'ZSeven', 'DSH Computer',
    STABLE_HELPER_APP_NAME, 'Contents', 'MacOS', HELPER_EXECUTABLE_NAME,
  )
}

export class ComputerPlatformError extends Error {
  readonly code = 'unsupported_platform'

  constructor(platform = process.platform) {
    super(`dsh-computer supports macOS only; current platform is ${platform}`)
    this.name = 'ComputerPlatformError'
  }
}

export class NativeHelperError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** True when transport loss happened after the helper process could have received an action. */
    readonly mayHaveExecuted = false,
  ) {
    super(message)
    this.name = 'NativeHelperError'
  }
}

interface RunResult {
  stdout: string
  stderr: string
}

export interface NativeHelperOptions {
  packageRoot?: string
  /** Explicit, intentionally unstable test/deployment override. Equivalent to DSH_COMPUTER_HELPER. */
  binaryPath?: string
  /** Primarily for isolated resolver tests; production defaults to the documented fixed app path. */
  stableBinaryPath?: string
  cacheRoot?: string
  platform?: NodeJS.Platform
}

interface NativeHelperResolution {
  path: string
  source: NativeHelperResolutionSource
  identityStable: boolean
}

interface NativeBuildState {
  controller: AbortController
  generation: number
  /** False once the final waiter leaves or the build settles; no later request may join it. */
  accepting: boolean
  waiters: Map<symbol, NativeBuildWaiter>
  promise: Promise<NativeHelperResolution>
}

interface NativeBuildWaiter {
  scopeId: string
  controller: AbortController
  done: Promise<void>
  finish(): void
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason
  const error = new Error('native helper request aborted')
  error.name = 'AbortError'
  return error
}

function runChild(
  command: string,
  args: string[],
  options: {
    input?: string
    signal?: AbortSignal
    timeoutMs: number
    cwd?: string
    /** Create and terminate a POSIX process group (Swift may spawn compiler children). */
    killProcessGroup?: boolean
    onSpawn?: (child: ChildProcessWithoutNullStreams) => void
    onClose?: (child: ChildProcessWithoutNullStreams) => void
  },
): Promise<RunResult> {
  if (options.signal?.aborted) return Promise.reject(abortError(options.signal.reason))

  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      shell: false,
      detached: options.killProcessGroup === true && process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    options.onSpawn?.(child)
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let settled = false
    let forceKill: NodeJS.Timeout | undefined

    const kill = (signal: NodeJS.Signals) => {
      if (options.killProcessGroup === true && process.platform !== 'win32' && child.pid !== undefined) {
        try { process.kill(-child.pid, signal); return } catch { /* fall back to the direct child */ }
      }
      child.kill(signal)
    }
    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      kill('SIGTERM')
      forceKill = setTimeout(() => kill('SIGKILL'), 750)
      forceKill.unref()
    }
    const onAbort = () => stop()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(stop, options.timeoutMs)
    timeout.unref()

    const collect = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > MAX_HELPER_OUTPUT_BYTES) {
        stop()
        return
      }
      if (kind === 'stdout') stdout += chunk.toString('utf8')
      else stderr += chunk.toString('utf8')
    }
    child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk))
    child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.on('close', (code, signal) => {
      options.onClose?.(child)
      clearTimeout(timeout)
      if (forceKill) clearTimeout(forceKill)
      options.signal?.removeEventListener('abort', onAbort)
      if (settled) return
      settled = true
      if (options.signal?.aborted) return reject(abortError(options.signal.reason))
      if (outputBytes > MAX_HELPER_OUTPUT_BYTES) {
        return reject(new NativeHelperError('helper_output_limit', 'native helper exceeded its output limit'))
      }
      if (code !== 0) {
        return reject(new NativeHelperError(
          'helper_process_failed',
          `native helper exited ${code ?? signal ?? 'unknown'}${stderr.trim() ? `: ${stderr.trim()}` : ''}`,
        ))
      }
      resolvePromise({ stdout, stderr })
    })
    child.stdin.on('error', () => { /* close path reports the authoritative outcome */ })
    child.stdin.end(options.input ?? '')
  })
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path)
    const metadata = await stat(path)
    return metadata.isFile() && (metadata.mode & 0o111) !== 0
  } catch {
    return false
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function isMachO(path: string): Promise<boolean> {
  const bytes = await readFile(path)
  if (bytes.length < 4) return false
  const magic = bytes.readUInt32BE(0)
  return new Set([
    0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe,
    0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca,
  ]).has(magic)
}

function identityError(path: string, detail: string): NativeHelperError {
  return new NativeHelperError(
    'helper_identity_invalid',
    `fixed DSH Computer Helper identity is invalid at ${path}: ${detail}. `
      + 'Run the explicit local Helper installer again with the intended signing identity; no permission prompt was opened.',
  )
}

/**
 * Validate the one resolver path that may claim a stable TCC identity.
 * Explicit overrides and development builds intentionally never call this path.
 */
async function validateStableBinary(path: string): Promise<void> {
  const binary = resolve(path)
  const macOSDir = dirname(binary)
  const contentsDir = dirname(macOSDir)
  const appDir = dirname(contentsDir)
  if (
    basename(binary) !== HELPER_EXECUTABLE_NAME
    || basename(macOSDir) !== 'MacOS'
    || basename(contentsDir) !== 'Contents'
    || basename(appDir) !== STABLE_HELPER_APP_NAME
  ) {
    throw identityError(binary, 'path does not have the fixed app bundle layout')
  }

  const expectedUid = process.getuid?.()
  for (const [candidate, kind] of [
    [appDir, 'directory'], [contentsDir, 'directory'], [macOSDir, 'directory'], [binary, 'file'],
  ] as const) {
    let metadata
    try {
      metadata = await lstat(candidate)
    } catch (error) {
      const detail = (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? `${kind} is missing`
        : `cannot inspect ${kind}: ${error instanceof Error ? error.message : String(error)}`
      throw identityError(binary, detail)
    }
    if (metadata.isSymbolicLink()) throw identityError(binary, `${candidate} is a symbolic link`)
    if (kind === 'directory' ? !metadata.isDirectory() : !metadata.isFile()) {
      throw identityError(binary, `${candidate} is not a ${kind}`)
    }
    if (expectedUid !== undefined && metadata.uid !== expectedUid) {
      throw identityError(binary, `${candidate} is owned by uid ${metadata.uid}, expected ${expectedUid}`)
    }
    if ((metadata.mode & 0o022) !== 0) {
      throw identityError(binary, `${candidate} is writable by group or other users`)
    }
  }
  if (!await isExecutable(binary)) throw identityError(binary, 'main executable is not executable')

  const [canonicalApp, canonicalBinary] = await Promise.all([realpath(appDir), realpath(binary)])
  if (canonicalApp !== appDir || canonicalBinary !== binary) {
    throw identityError(binary, 'the fixed path resolves through a symbolic link')
  }

  try {
    await runChild('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appDir], {
      timeoutMs: SIGNATURE_TIMEOUT_MS,
    })
    const described = await runChild('/usr/bin/codesign', ['-d', '--verbose=4', appDir], {
      timeoutMs: SIGNATURE_TIMEOUT_MS,
    })
    const details = `${described.stdout}\n${described.stderr}`
    const identifier = /^Identifier=(.+)$/mu.exec(details)?.[1]?.trim()
    const teamIdentifier = /^TeamIdentifier=(.+)$/mu.exec(details)?.[1]?.trim()
    const isAdHoc = /^Signature=adhoc$/mu.test(details) || teamIdentifier === 'not set'
    if (identifier !== STABLE_HELPER_BUNDLE_ID) {
      throw identityError(binary, `signed identifier is ${identifier ?? 'missing'}, expected ${STABLE_HELPER_BUNDLE_ID}`)
    }
    if (isAdHoc || teamIdentifier === undefined || teamIdentifier === '') {
      throw identityError(binary, 'signature is ad-hoc or has no TeamIdentifier')
    }
  } catch (error) {
    if (error instanceof NativeHelperError && error.code === 'helper_identity_invalid') throw error
    throw identityError(binary, `code signature verification failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const STATUS_SIGNING_KINDS = new Set([
  'development', 'developer-id', 'distribution', 'other', 'adhoc', 'unsigned',
])
const STATUS_RESOLUTION_SOURCES = new Set<NativeHelperResolutionSource>([
  'explicit-override', 'installed-app', 'worktree-build', 'cache-build',
])

function invalidStatus(detail: string): never {
  throw new NativeHelperError('invalid_helper_response', `native helper returned invalid status: ${detail}`)
}

function exactRecord(value: unknown, label: string, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidStatus(`${label} must be an object`)
  const record = value as Record<string, unknown>
  const expected = new Set(fields)
  for (const field of fields) {
    if (!Object.hasOwn(record, field)) invalidStatus(`${label}.${field} is missing`)
  }
  for (const field of Object.keys(record)) {
    if (!expected.has(field)) invalidStatus(`${label}.${field} is unsupported`)
  }
  return record
}

function booleanField(record: Record<string, unknown>, field: string, label: string): boolean {
  const value = record[field]
  if (typeof value !== 'boolean') invalidStatus(`${label}.${field} must be boolean`)
  return value
}

function stringField(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    invalidStatus(`${label}.${field} must be a non-empty string without NUL`)
  }
  return value
}

function nullableStringField(record: Record<string, unknown>, field: string, label: string): string | null {
  const value = record[field]
  if (value === null) return null
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    invalidStatus(`${label}.${field} must be null or a non-empty string without NUL`)
  }
  return value
}

function absolutePathField(record: Record<string, unknown>, field: string, label: string): string {
  const value = stringField(record, field, label)
  if (resolve(value) !== value) invalidStatus(`${label}.${field} must be an absolute normalized path`)
  return value
}

function nullableAbsolutePathField(record: Record<string, unknown>, field: string, label: string): string | null {
  const value = nullableStringField(record, field, label)
  if (value !== null && resolve(value) !== value) invalidStatus(`${label}.${field} must be an absolute normalized path or null`)
  return value
}

function safeIntegerField(
  record: Record<string, unknown>,
  field: string,
  label: string,
  minimum = Number.MIN_SAFE_INTEGER,
): number {
  const value = record[field]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    invalidStatus(`${label}.${field} must be a safe integer${minimum > Number.MIN_SAFE_INTEGER ? ` >= ${minimum}` : ''}`)
  }
  return value
}

function validateNativeStatus(value: unknown): NativeStatusResult {
  const status = exactRecord(value, 'status', [
    'platform', 'accessibilityTrusted', 'screenRecordingTrusted', 'sessionLocked',
    'interactiveSessionAvailable', 'helperVersion', 'helperExecutable', 'bundle',
    'signing', 'process', 'caller', 'resolution', 'identityStable',
  ])
  if (status.platform !== 'macos') invalidStatus('status.platform must equal macos')
  const accessibilityTrusted = booleanField(status, 'accessibilityTrusted', 'status')
  const screenRecordingTrusted = booleanField(status, 'screenRecordingTrusted', 'status')
  const sessionLocked = booleanField(status, 'sessionLocked', 'status')
  const interactiveSessionAvailable = booleanField(status, 'interactiveSessionAvailable', 'status')
  if (sessionLocked && interactiveSessionAvailable) {
    invalidStatus('status.interactiveSessionAvailable cannot be true while status.sessionLocked is true')
  }
  const helperVersion = stringField(status, 'helperVersion', 'status')
  if (helperVersion !== HELPER_PROTOCOL_VERSION) {
    invalidStatus(`status.helperVersion must equal ${HELPER_PROTOCOL_VERSION}`)
  }
  const helperExecutable = absolutePathField(status, 'helperExecutable', 'status')

  const bundleRecord = exactRecord(status.bundle, 'status.bundle', ['path', 'identifier', 'version'])
  const bundle = {
    path: nullableAbsolutePathField(bundleRecord, 'path', 'status.bundle'),
    identifier: nullableStringField(bundleRecord, 'identifier', 'status.bundle'),
    version: nullableStringField(bundleRecord, 'version', 'status.bundle'),
  }

  const signingRecord = exactRecord(status.signing, 'status.signing', [
    'signed', 'kind', 'codeIdentifier', 'teamIdentifier', 'authorities',
    'cdhash', 'statusCode', 'detail',
  ])
  const signed = booleanField(signingRecord, 'signed', 'status.signing')
  const kind = stringField(signingRecord, 'kind', 'status.signing')
  if (!STATUS_SIGNING_KINDS.has(kind)) invalidStatus('status.signing.kind is unsupported')
  if ((signed && kind === 'unsigned') || (!signed && kind !== 'unsigned')) {
    invalidStatus('status.signing.signed and status.signing.kind are inconsistent')
  }
  const authoritiesValue = signingRecord.authorities
  if (!Array.isArray(authoritiesValue) || authoritiesValue.some(authority => (
    typeof authority !== 'string' || authority.length === 0 || authority.includes('\0')
  ))) {
    invalidStatus('status.signing.authorities must be an array of non-empty strings without NUL')
  }
  const cdhash = nullableStringField(signingRecord, 'cdhash', 'status.signing')
  if (cdhash !== null && (!/^[0-9a-f]+$/iu.test(cdhash) || cdhash.length % 2 !== 0)) {
    invalidStatus('status.signing.cdhash must be an even-length hexadecimal string or null')
  }
  const signing = {
    signed,
    kind: kind as NativeStatusResult['signing']['kind'],
    codeIdentifier: nullableStringField(signingRecord, 'codeIdentifier', 'status.signing'),
    teamIdentifier: nullableStringField(signingRecord, 'teamIdentifier', 'status.signing'),
    authorities: authoritiesValue as string[],
    cdhash,
    statusCode: safeIntegerField(signingRecord, 'statusCode', 'status.signing'),
    detail: nullableStringField(signingRecord, 'detail', 'status.signing'),
  }

  const processRecord = exactRecord(status.process, 'status.process', ['pid', 'ppid'])
  const processIdentity = {
    pid: safeIntegerField(processRecord, 'pid', 'status.process', 1),
    ppid: safeIntegerField(processRecord, 'ppid', 'status.process', 0),
  }

  const callerRecord = exactRecord(status.caller, 'status.caller', [
    'pid', 'executable', 'bundleIdentifier', 'name',
  ])
  const caller = {
    pid: safeIntegerField(callerRecord, 'pid', 'status.caller', 0),
    executable: nullableAbsolutePathField(callerRecord, 'executable', 'status.caller'),
    bundleIdentifier: nullableStringField(callerRecord, 'bundleIdentifier', 'status.caller'),
    name: nullableStringField(callerRecord, 'name', 'status.caller'),
  }

  const resolutionRecord = exactRecord(status.resolution, 'status.resolution', ['source', 'selectedPath'])
  const source = stringField(resolutionRecord, 'source', 'status.resolution')
  if (!STATUS_RESOLUTION_SOURCES.has(source as NativeHelperResolutionSource)) {
    invalidStatus('status.resolution.source is unsupported')
  }
  const nativeResolution = {
    source: source as NativeHelperResolutionSource,
    selectedPath: absolutePathField(resolutionRecord, 'selectedPath', 'status.resolution'),
  }

  return {
    platform: 'macos', accessibilityTrusted, screenRecordingTrusted,
    sessionLocked, interactiveSessionAvailable, helperVersion, helperExecutable,
    bundle, signing, process: processIdentity, caller, resolution: nativeResolution,
    identityStable: booleanField(status, 'identityStable', 'status'),
  }
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const result: string[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await sourceFiles(path))
    else if (entry.isFile() && (entry.name.endsWith('.swift') || entry.name === 'Package.swift')) result.push(path)
  }
  return result
}

async function helperSourceDigest(nativeDir: string): Promise<string> {
  const hash = createHash('sha256')
  for (const path of [join(nativeDir, 'Package.swift'), ...await sourceFiles(join(nativeDir, 'Sources'))]) {
    hash.update(path.slice(nativeDir.length))
    hash.update(await readFile(path))
  }
  return hash.digest('hex').slice(0, 20)
}

/** Owns helper compilation, process cancellation, and per-scope process sets. */
export class NativeHelper implements NativeTransport {
  readonly #packageRoot: string
  readonly #nativeDir: string
  readonly #explicitBinary: string | undefined
  readonly #stableBinary: string
  readonly #cacheRoot: string
  readonly #platform: NodeJS.Platform
  readonly #children = new Map<string, Set<ChildProcessWithoutNullStreams>>()
  readonly #scopeGenerations = new Map<string, number>()
  readonly #buildChildren = new Set<ChildProcessWithoutNullStreams>()
  #resolution: NativeHelperResolution | undefined
  #build: NativeBuildState | undefined
  #generation = 0
  #disposed = false

  constructor(options: NativeHelperOptions = {}) {
    const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    this.#packageRoot = resolve(options.packageRoot ?? defaultRoot)
    this.#nativeDir = join(this.#packageRoot, 'native')
    this.#explicitBinary = options.binaryPath ?? process.env.DSH_COMPUTER_HELPER
    this.#stableBinary = resolve(options.stableBinaryPath ?? defaultStableBinaryPath())
    this.#cacheRoot = options.cacheRoot ?? join(homedir(), 'Library', 'Caches', 'dsh-computer', 'helper')
    this.#platform = options.platform ?? process.platform
  }

  active(scopeId: string): number {
    const buildWaiters = [...(this.#build?.waiters.values() ?? [])]
      .filter(waiter => waiter.scopeId === scopeId).length
    return (this.#children.get(scopeId)?.size ?? 0) + buildWaiters
  }

  #scopeGeneration(scopeId: string): number {
    return this.#scopeGenerations.get(scopeId) ?? 0
  }

  #assertGeneration(generation: number, signal: AbortSignal): void {
    if (signal.aborted) throw abortError(signal.reason)
    if (this.#disposed || generation !== this.#generation) {
      throw new NativeHelperError('disposed', 'native helper was disposed while resolving its binary')
    }
  }

  async #stageDevelopmentBinary(
    built: string,
    cached: string,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    this.#assertGeneration(generation, signal)
    const targetDir = dirname(cached)
    await mkdir(targetDir, { recursive: true })
    this.#assertGeneration(generation, signal)
    const temporary = join(targetDir, `.dsh-computer-helper-${process.pid}-${randomBytes(5).toString('hex')}`)
    await copyFile(built, temporary)
    this.#assertGeneration(generation, signal)
    await chmod(temporary, 0o755)
    this.#assertGeneration(generation, signal)
    if (await isMachO(temporary)) {
      // SwiftPM linker signatures plus macOS provenance can leave a local
      // worktree executable blocked before main. A deterministic ad-hoc code
      // identifier needs no keychain and makes the staged development copy a
      // normal locally signed Mach-O. This is still identityStable:false and
      // is never confused with the certificate-backed fixed Helper app.
      await runChild('/usr/bin/codesign', [
        '--force', '--identifier', DEVELOPMENT_HELPER_CODE_ID, '--sign', '-', temporary,
      ], { timeoutMs: SIGNATURE_TIMEOUT_MS, signal })
      this.#assertGeneration(generation, signal)
      await runChild('/usr/bin/codesign', [
        '--verify', '--strict', '--verbose=2', temporary,
      ], { timeoutMs: SIGNATURE_TIMEOUT_MS, signal })
      this.#assertGeneration(generation, signal)
    }
    try {
      await rename(temporary, cached)
    } catch (error) {
      await rm(temporary, { force: true })
      if (!await isExecutable(cached)) throw error
    }
    this.#assertGeneration(generation, signal)
  }

  async #resolveBinary(signal: AbortSignal, generation: number): Promise<NativeHelperResolution> {
    this.#assertGeneration(generation, signal)
    if (this.#platform !== 'darwin') throw new ComputerPlatformError(this.#platform)
    if (this.#explicitBinary) {
      const binary = resolve(this.#explicitBinary)
      if (!await isExecutable(binary)) {
        throw new NativeHelperError('helper_unavailable', `explicit DSH Computer Helper override is not executable: ${binary}`)
      }
      this.#assertGeneration(generation, signal)
      return { path: binary, source: 'explicit-override', identityStable: false }
    }

    if (await pathExists(this.#stableBinary)) {
      await validateStableBinary(this.#stableBinary)
      this.#assertGeneration(generation, signal)
      return { path: this.#stableBinary, source: 'installed-app', identityStable: true }
    }

    const worktreeBinary = join(this.#nativeDir, '.build', 'release', HELPER_EXECUTABLE_NAME)
    if (await isExecutable(worktreeBinary)) {
      // Never execute SwiftPM's worktree artifact in place. On current macOS,
      // provenance/Gatekeeper can hold that file before main even though an
      // ordinary Node copy of the same locally built Mach-O launches normally.
      // Content-addressing the staged copy also makes a rebuild select a new
      // cache entry without trusting source mtimes.
      const binaryDigest = createHash('sha256').update(await readFile(worktreeBinary)).digest('hex').slice(0, 20)
      const staged = join(this.#cacheRoot, `worktree-signed-${binaryDigest}`, HELPER_EXECUTABLE_NAME)
      if (!await isExecutable(staged)) {
        await this.#stageDevelopmentBinary(worktreeBinary, staged, signal, generation)
      }
      this.#assertGeneration(generation, signal)
      return { path: staged, source: 'worktree-build', identityStable: false }
    }

    const digest = await helperSourceDigest(this.#nativeDir)
    this.#assertGeneration(generation, signal)
    const cached = join(this.#cacheRoot, `source-signed-${digest}`, HELPER_EXECUTABLE_NAME)
    if (await isExecutable(cached)) {
      this.#assertGeneration(generation, signal)
      return { path: cached, source: 'cache-build', identityStable: false }
    }

    const scratch = await mkdtemp(join(tmpdir(), 'dsh-computer-swift-'))
    try {
      const buildDir = join(scratch, 'build')
      await runChild('swift', [
        'build', '-c', 'release', '--package-path', this.#nativeDir, '--scratch-path', buildDir,
      ], {
        timeoutMs: BUILD_TIMEOUT_MS,
        signal,
        killProcessGroup: true,
        onSpawn: child => this.#buildChildren.add(child),
        onClose: child => this.#buildChildren.delete(child),
      })
      this.#assertGeneration(generation, signal)
      const shown = await runChild('swift', [
        'build', '-c', 'release', '--package-path', this.#nativeDir, '--scratch-path', buildDir, '--show-bin-path',
      ], {
        timeoutMs: BUILD_TIMEOUT_MS,
        signal,
        killProcessGroup: true,
        onSpawn: child => this.#buildChildren.add(child),
        onClose: child => this.#buildChildren.delete(child),
      })
      this.#assertGeneration(generation, signal)
      const built = join(shown.stdout.trim(), HELPER_EXECUTABLE_NAME)
      if (!await isExecutable(built)) throw new NativeHelperError('helper_build_failed', 'Swift build produced no helper executable')
      await this.#stageDevelopmentBinary(built, cached, signal, generation)
      return { path: cached, source: 'cache-build', identityStable: false }
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  }

  #startBuild(): NativeBuildState {
    const controller = new AbortController()
    const generation = this.#generation
    const state: NativeBuildState = {
      controller,
      generation,
      accepting: true,
      waiters: new Map(),
      promise: Promise.resolve({ path: '', source: 'cache-build', identityStable: false }),
    }
    state.promise = this.#resolveBinary(controller.signal, generation)
      .then(resolution => {
        this.#assertGeneration(generation, controller.signal)
        this.#resolution = resolution
        return resolution
      })
      .finally(() => {
        state.accepting = false
        if (this.#build === state) this.#build = undefined
      })
    this.#build = state
    return state
  }

  async #ensureBinary(scopeId: string, signal?: AbortSignal): Promise<NativeHelperResolution> {
    if (this.#disposed) throw new NativeHelperError('disposed', 'native helper is disposed')
    if (signal?.aborted) throw abortError(signal.reason)
    const scopeGeneration = this.#scopeGeneration(scopeId)
    let state: NativeBuildState
    while (true) {
      if (this.#disposed) throw new NativeHelperError('disposed', 'native helper is disposed')
      if (signal?.aborted) throw abortError(signal.reason)
      if (this.#scopeGeneration(scopeId) !== scopeGeneration) {
        throw new NativeHelperError('scope_disposed', `native helper scope was disposed: ${scopeId}`)
      }
      if (this.#resolution) {
        if (this.#resolution.source === 'installed-app') await validateStableBinary(this.#resolution.path)
        return this.#resolution
      }
      const current = this.#build
      if (current === undefined) {
        state = this.#startBuild()
        break
      }
      if (current.accepting) {
        state = current
        break
      }
      // A final waiter has already closed this generation. Waiting for its
      // compiler/process group to reach quiescence keeps new callers out of the
      // cancelled promise and ensures only one continuation starts the next build.
      await current.promise.catch(() => undefined)
    }
    const token = Symbol(scopeId)
    const controller = new AbortController()
    let finish!: () => void
    const done = new Promise<void>(resolvePromise => { finish = resolvePromise })
    const waiter: NativeBuildWaiter = { scopeId, controller, done, finish }
    state.waiters.set(token, waiter)
    const onCallerAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onCallerAbort, { once: true })
    const buildOutcome = state.promise.then(
      resolution => ({ kind: 'binary' as const, resolution }),
      error => ({ kind: 'build-error' as const, error }),
    )
    let resolveWaiterAbort!: () => void
    const waiterAbort = new Promise<{ kind: 'waiter-abort' }>(resolvePromise => {
      resolveWaiterAbort = () => resolvePromise({ kind: 'waiter-abort' })
    })
    controller.signal.addEventListener('abort', resolveWaiterAbort, { once: true })
    try {
      const outcome = await Promise.race([buildOutcome, waiterAbort])
      if (outcome.kind === 'waiter-abort') {
        state.waiters.delete(token)
        // The shared Swift build belongs to all current waiters. One Agent can
        // leave independently; only the final waiter may terminate the build.
        if (state.waiters.size === 0) {
          if (state.accepting) {
            // Close admission synchronously before aborting. A caller arriving
            // in the slow SIGTERM/SIGKILL window waits for this state to clear
            // and then joins or creates one fresh build generation.
            state.accepting = false
            state.controller.abort(controller.signal.reason)
          }
          // Global dispose may have closed/aborted the state first. The final
          // waiter still stays pending until the shared process is quiescent,
          // preserving the request/dispose ordering contract.
          await state.promise.catch(() => undefined)
        }
        throw abortError(controller.signal.reason)
      }
      if (outcome.kind === 'build-error') throw outcome.error
      const resolution = outcome.resolution
      if (signal?.aborted) throw abortError(signal.reason)
      if (this.#disposed || state.generation !== this.#generation) {
        throw new NativeHelperError('disposed', 'native helper was disposed before the request could start')
      }
      if (resolution.source === 'installed-app') await validateStableBinary(resolution.path)
      return resolution
    } finally {
      state.waiters.delete(token)
      signal?.removeEventListener('abort', onCallerAbort)
      controller.signal.removeEventListener('abort', resolveWaiterAbort)
      finish()
    }
  }

  async request<T extends NativeStatusResult | NativeObserveResult | NativeActionResult | NativeCaptureResult>(
    request: NativeRequest,
    options: { scopeId: string; signal?: AbortSignal },
  ): Promise<T> {
    const scopeGeneration = this.#scopeGeneration(options.scopeId)
    const resolution = await this.#ensureBinary(options.scopeId, options.signal)
    if (options.signal?.aborted) throw abortError(options.signal.reason)
    if (this.#disposed) throw new NativeHelperError('disposed', 'native helper is disposed')
    if (this.#scopeGeneration(options.scopeId) !== scopeGeneration) {
      throw new NativeHelperError('scope_disposed', 'native helper scope was disposed before the request could start')
    }

    const scope = this.#children.get(options.scopeId) ?? new Set<ChildProcessWithoutNullStreams>()
    this.#children.set(options.scopeId, scope)
    let spawned = false
    let result: RunResult
    try {
      result = await runChild(resolution.path, [], {
        input: `${JSON.stringify(request)}\n`,
        timeoutMs: HELPER_TIMEOUT_MS,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        onSpawn: child => {
          spawned = true
          scope.add(child)
        },
        onClose: child => {
          scope.delete(child)
          if (scope.size === 0) this.#children.delete(options.scopeId)
        },
      })
    } catch (error) {
      if (request.command === 'act' && spawned) {
        const code = error instanceof NativeHelperError ? error.code : 'helper_transport_lost'
        throw new NativeHelperError(code, error instanceof Error ? error.message : String(error), true)
      }
      throw error
    }
    const line = result.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)
    if (!line) throw new NativeHelperError(
      'invalid_helper_response', 'native helper returned no JSON response', request.command === 'act',
    )
    let response: NativeResponse
    try {
      response = JSON.parse(line) as NativeResponse
    } catch {
      throw new NativeHelperError('invalid_helper_response', 'native helper returned invalid JSON', request.command === 'act')
    }
    if (response.id !== request.id) {
      throw new NativeHelperError('invalid_helper_response', 'native helper response id mismatch', request.command === 'act')
    }
    if (!response.ok || response.result === undefined) {
      throw new NativeHelperError(response.error?.code ?? 'helper_error', response.error?.message ?? 'native helper failed')
    }
    if (request.command === 'status') {
      const status = validateNativeStatus(response.result)
      if (resolution.source === 'installed-app') {
        let reportedExecutable: string
        try {
          reportedExecutable = await realpath(status.helperExecutable)
        } catch (error) {
          throw identityError(resolution.path, `status reported an unreadable executable path: ${error instanceof Error ? error.message : String(error)}`)
        }
        const selectedExecutable = await realpath(resolution.path)
        if (reportedExecutable !== selectedExecutable) {
          throw identityError(resolution.path, `status was returned by unexpected executable ${reportedExecutable}`)
        }
        const selectedApp = dirname(dirname(dirname(selectedExecutable)))
        let reportedApp: string | null = null
        try {
          reportedApp = status.bundle.path === null ? null : await realpath(status.bundle.path)
        } catch (error) {
          throw identityError(
            resolution.path,
            `status reported an unreadable app bundle: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        if (reportedApp === null || reportedApp !== await realpath(selectedApp)) {
          throw identityError(resolution.path, `status reported unexpected app bundle ${status.bundle.path ?? 'null'}`)
        }
        if (status.bundle.identifier !== STABLE_HELPER_BUNDLE_ID) {
          throw identityError(
            resolution.path,
            `status reported bundle identifier ${status.bundle.identifier ?? 'null'}, expected ${STABLE_HELPER_BUNDLE_ID}`,
          )
        }
        if (
          !status.signing.signed
          || status.signing.kind === 'adhoc'
          || status.signing.kind === 'unsigned'
          || status.signing.teamIdentifier === null
          || status.signing.codeIdentifier !== STABLE_HELPER_BUNDLE_ID
          || status.signing.statusCode !== 0
        ) {
          throw identityError(resolution.path, 'status did not confirm the fixed certificate-backed code identity')
        }
      }
      return {
        ...status,
        resolution: { source: resolution.source, selectedPath: resolution.path },
        identityStable: resolution.identityStable,
      } as T
    }
    return response.result as T
  }

  async disposeScope(scopeId: string): Promise<void> {
    this.#scopeGenerations.set(scopeId, this.#scopeGeneration(scopeId) + 1)
    const build = this.#build
    if (build) {
      const waiters = [...build.waiters.values()].filter(waiter => waiter.scopeId === scopeId)
      for (const waiter of waiters) waiter.controller.abort(new Error(`native helper scope disposed: ${scopeId}`))
      await Promise.all(waiters.map(waiter => waiter.done))
    }
    const children = [...(this.#children.get(scopeId) ?? [])]
    for (const child of children) child.kill('SIGTERM')
    await Promise.all(children.map(child => new Promise<void>(resolvePromise => {
      if (child.exitCode !== null || child.signalCode !== null) return resolvePromise()
      let timer: NodeJS.Timeout
      child.once('close', () => {
        clearTimeout(timer)
        resolvePromise()
      })
      timer = setTimeout(() => {
        child.kill('SIGKILL')
        resolvePromise()
      }, 1_000)
      timer.unref()
    })))
    this.#children.delete(scopeId)
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    this.#generation += 1
    const build = this.#build
    if (build) {
      build.accepting = false
      const waiters = [...build.waiters.values()]
      for (const waiter of waiters) waiter.controller.abort(new Error('native helper disposed'))
      build.controller.abort(new Error('native helper disposed'))
      await build.promise.catch(() => undefined)
      await Promise.all(waiters.map(waiter => waiter.done))
    }
    for (const child of this.#buildChildren) child.kill('SIGKILL')
    this.#buildChildren.clear()
    await Promise.all([...this.#children.keys()].map(scope => this.disposeScope(scope)))
    this.#scopeGenerations.clear()
  }
}
