import { createHash, randomBytes } from 'node:crypto'
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type {
  NativeActionResult,
  NativeObserveResult,
  NativeRequest,
  NativeResponse,
  NativeStatusResult,
  NativeTransport,
} from './native-protocol.js'

const MAX_HELPER_OUTPUT_BYTES = 4 * 1024 * 1024
const HELPER_TIMEOUT_MS = 20_000
const BUILD_TIMEOUT_MS = 180_000

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
  binaryPath?: string
  cacheRoot?: string
  platform?: NodeJS.Platform
}

interface NativeBuildState {
  controller: AbortController
  generation: number
  waiters: Map<symbol, NativeBuildWaiter>
  promise: Promise<string>
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
  readonly #cacheRoot: string
  readonly #platform: NodeJS.Platform
  readonly #children = new Map<string, Set<ChildProcessWithoutNullStreams>>()
  readonly #scopeGenerations = new Map<string, number>()
  readonly #buildChildren = new Set<ChildProcessWithoutNullStreams>()
  #binaryPath: string | undefined
  #build: NativeBuildState | undefined
  #generation = 0
  #disposed = false

  constructor(options: NativeHelperOptions = {}) {
    const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    this.#packageRoot = resolve(options.packageRoot ?? defaultRoot)
    this.#nativeDir = join(this.#packageRoot, 'native')
    this.#explicitBinary = options.binaryPath ?? process.env.DSH_COMPUTER_HELPER
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

  async #resolveBinary(signal: AbortSignal, generation: number): Promise<string> {
    this.#assertGeneration(generation, signal)
    if (this.#platform !== 'darwin') throw new ComputerPlatformError(this.#platform)
    if (this.#explicitBinary) {
      const binary = resolve(this.#explicitBinary)
      if (!await isExecutable(binary)) {
        throw new NativeHelperError('helper_unavailable', `DSH_COMPUTER_HELPER is not executable: ${binary}`)
      }
      this.#assertGeneration(generation, signal)
      return binary
    }

    const worktreeBinary = join(this.#nativeDir, '.build', 'release', 'dsh-computer-helper')
    if (await isExecutable(worktreeBinary)) {
      this.#assertGeneration(generation, signal)
      return worktreeBinary
    }

    const digest = await helperSourceDigest(this.#nativeDir)
    this.#assertGeneration(generation, signal)
    const cached = join(this.#cacheRoot, digest, 'dsh-computer-helper')
    if (await isExecutable(cached)) {
      this.#assertGeneration(generation, signal)
      return cached
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
      const built = join(shown.stdout.trim(), 'dsh-computer-helper')
      if (!await isExecutable(built)) throw new NativeHelperError('helper_build_failed', 'Swift build produced no helper executable')
      this.#assertGeneration(generation, signal)
      const targetDir = dirname(cached)
      await mkdir(targetDir, { recursive: true })
      this.#assertGeneration(generation, signal)
      const temporary = join(targetDir, `.dsh-computer-helper-${process.pid}-${randomBytes(5).toString('hex')}`)
      await copyFile(built, temporary)
      this.#assertGeneration(generation, signal)
      await chmod(temporary, 0o755)
      this.#assertGeneration(generation, signal)
      try {
        await rename(temporary, cached)
      } catch (error) {
        await rm(temporary, { force: true })
        if (!await isExecutable(cached)) throw error
      }
      this.#assertGeneration(generation, signal)
      return cached
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
      waiters: new Map(),
      promise: Promise.resolve(''),
    }
    state.promise = this.#resolveBinary(controller.signal, generation)
      .then(binary => {
        this.#assertGeneration(generation, controller.signal)
        this.#binaryPath = binary
        return binary
      })
      .finally(() => {
        if (this.#build === state) this.#build = undefined
      })
    this.#build = state
    return state
  }

  async #ensureBinary(scopeId: string, signal?: AbortSignal): Promise<string> {
    if (this.#disposed) throw new NativeHelperError('disposed', 'native helper is disposed')
    if (signal?.aborted) throw abortError(signal.reason)
    if (this.#binaryPath) return this.#binaryPath
    const state = this.#build ?? this.#startBuild()
    const token = Symbol(scopeId)
    const controller = new AbortController()
    let finish!: () => void
    const done = new Promise<void>(resolvePromise => { finish = resolvePromise })
    const waiter: NativeBuildWaiter = { scopeId, controller, done, finish }
    state.waiters.set(token, waiter)
    const onCallerAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onCallerAbort, { once: true })
    const buildOutcome = state.promise.then(
      binary => ({ kind: 'binary' as const, binary }),
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
          state.controller.abort(controller.signal.reason)
          await state.promise.catch(() => undefined)
        }
        throw abortError(controller.signal.reason)
      }
      if (outcome.kind === 'build-error') throw outcome.error
      const binary = outcome.binary
      if (signal?.aborted) throw abortError(signal.reason)
      if (this.#disposed || state.generation !== this.#generation) {
        throw new NativeHelperError('disposed', 'native helper was disposed before the request could start')
      }
      return binary
    } finally {
      state.waiters.delete(token)
      signal?.removeEventListener('abort', onCallerAbort)
      controller.signal.removeEventListener('abort', resolveWaiterAbort)
      finish()
    }
  }

  async request<T extends NativeStatusResult | NativeObserveResult | NativeActionResult>(
    request: NativeRequest,
    options: { scopeId: string; signal?: AbortSignal },
  ): Promise<T> {
    const scopeGeneration = this.#scopeGeneration(options.scopeId)
    const binary = await this.#ensureBinary(options.scopeId, options.signal)
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
      result = await runChild(binary, [], {
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
