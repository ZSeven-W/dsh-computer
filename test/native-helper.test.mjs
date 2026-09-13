import assert from 'node:assert/strict'
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import test from 'node:test'
import { NativeHelper } from '../lib/index.js'

async function waitFor(path, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { await access(path); return } catch { await new Promise(resolve => setTimeout(resolve, 20)) }
  }
  throw new Error(`timed out waiting for ${path}`)
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-computer-build-cancel-'))
  const native = join(root, 'native')
  const bin = join(root, 'bin')
  await mkdir(join(native, 'Sources', 'Fixture'), { recursive: true })
  await mkdir(bin)
  await writeFile(join(native, 'Package.swift'), '// swift-tools-version: 6.0\n')
  await writeFile(join(native, 'Sources', 'Fixture', 'main.swift'), 'print("fixture")\n')
  const fakeSwift = join(bin, 'swift')
  await copyFile(join(import.meta.dirname, 'fixtures', 'fake-swift.cjs'), fakeSwift)
  await chmod(fakeSwift, 0o755)
  return { root, bin, marker: join(root, 'swift.marker') }
}

async function fakeHelper(path, mutation = '') {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `#!/usr/bin/env node
const chunks = []
process.stdin.on('data', chunk => chunks.push(chunk))
process.stdin.on('end', () => {
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const result = {
    platform: 'macos', accessibilityTrusted: false, screenRecordingTrusted: false,
    sessionLocked: false, interactiveSessionAvailable: true,
    helperVersion: '0.1.0-rc.1', helperExecutable: process.argv[1],
    bundle: { path: null, identifier: null, version: null },
    signing: { signed: false, kind: 'unsigned', codeIdentifier: null, teamIdentifier: null, authorities: [], cdhash: null, statusCode: 0, detail: 'fixture' },
    process: { pid: process.pid, ppid: process.ppid },
    caller: { pid: process.ppid, executable: null, bundleIdentifier: null, name: null },
    resolution: { source: 'cache-build', selectedPath: process.argv[1] }, identityStable: false,
  }
  ${mutation}
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + '\\n')
})
`)
  await chmod(path, 0o755)
}

async function rejectsInvalidStatus(mutation, detailPattern) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-computer-status-invalid-'))
  const explicit = join(root, 'explicit-helper')
  try {
    await fakeHelper(explicit, mutation)
    const helper = new NativeHelper({
      packageRoot: root,
      binaryPath: explicit,
      stableBinaryPath: join(root, 'missing-stable'),
      platform: 'darwin',
    })
    try {
      await assert.rejects(
        helper.request({ id: 'status', command: 'status' }, { scopeId: 'status-validation' }),
        error => error?.code === 'invalid_helper_response' && detailPattern.test(error.message),
      )
    } finally {
      await helper.dispose()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('status rejects a missing required field instead of leaking undefined', async () => {
  await rejectsInvalidStatus('delete result.sessionLocked', /status\.sessionLocked is missing/u)
})

test('status rejects a Helper protocol version mismatch', async () => {
  await rejectsInvalidStatus("result.helperVersion = '0.1.0-rc.0'", /helperVersion must equal 0\.1\.0-rc\.1/u)
})

test('status rejects malformed nested values, unsafe integers, enums, booleans, and resolution', async (t) => {
  const cases = [
    ['bundle array', 'result.bundle = []', /status\.bundle must be an object/u],
    ['signing enum', "result.signing.kind = 'mystery'", /status\.signing\.kind is unsupported/u],
    ['unsafe pid', 'result.process.pid = Number.MAX_SAFE_INTEGER + 1', /status\.process\.pid must be a safe integer/u],
    ['boolean string', "result.accessibilityTrusted = 'false'", /accessibilityTrusted must be boolean/u],
    ['resolution source', "result.resolution.source = 'side-load'", /status\.resolution\.source is unsupported/u],
  ]
  for (const [name, mutation, pattern] of cases) {
    await t.test(name, () => rejectsInvalidStatus(mutation, pattern))
  }
})

test('DSHPLUGIN_COMPUTER_HELPER is an explicit unstable override ahead of the fixed app and development build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-computer-resolver-explicit-'))
  const explicit = join(root, 'explicit-helper')
  const stable = join(root, 'DSH Computer Helper.app', 'Contents', 'MacOS', 'dsh-computer-helper')
  const worktree = join(root, 'native', '.build', 'release', 'dsh-computer-helper')
  const prior = process.env.DSHPLUGIN_COMPUTER_HELPER
  try {
    await Promise.all([fakeHelper(explicit), fakeHelper(stable), fakeHelper(worktree)])
    process.env.DSHPLUGIN_COMPUTER_HELPER = explicit
    const helper = new NativeHelper({ packageRoot: root, stableBinaryPath: stable, platform: 'darwin' })
    const status = await helper.request({ id: 'status', command: 'status' }, { scopeId: 'resolver' })
    assert.equal(status.resolution.source, 'explicit-override')
    assert.equal(status.resolution.selectedPath, explicit)
    assert.equal(status.identityStable, false)
    assert.equal(status.helperExecutable, explicit)
    await helper.dispose()
  } finally {
    if (prior === undefined) delete process.env.DSHPLUGIN_COMPUTER_HELPER
    else process.env.DSHPLUGIN_COMPUTER_HELPER = prior
    await rm(root, { recursive: true, force: true })
  }
})
test('the legacy DSH_COMPUTER_HELPER name still resolves, so existing shell exports keep working', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-computer-resolver-legacy-'))
  const explicit = join(root, 'explicit-helper')
  const stable = join(root, 'DSH Computer Helper.app', 'Contents', 'MacOS', 'dsh-computer-helper')
  const worktree = join(root, 'native', '.build', 'release', 'dsh-computer-helper')
  const prior = process.env.DSH_COMPUTER_HELPER
  try {
    await Promise.all([fakeHelper(explicit), fakeHelper(stable), fakeHelper(worktree)])
    process.env.DSH_COMPUTER_HELPER = explicit
    const helper = new NativeHelper({ packageRoot: root, stableBinaryPath: stable, platform: 'darwin' })
    const status = await helper.request({ id: 'status', command: 'status' }, { scopeId: 'resolver' })
    assert.equal(status.resolution.source, 'explicit-override')
    assert.equal(status.resolution.selectedPath, explicit)
    assert.equal(status.identityStable, false)
    assert.equal(status.helperExecutable, explicit)
    await helper.dispose()
  } finally {
    if (prior === undefined) delete process.env.DSH_COMPUTER_HELPER
    else process.env.DSH_COMPUTER_HELPER = prior
    await rm(root, { recursive: true, force: true })
  }
})

test('worktree helper is an honest identity-unstable fallback when the fixed app is absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-computer-resolver-worktree-'))
  const stable = join(root, 'DSH Computer Helper.app', 'Contents', 'MacOS', 'dsh-computer-helper')
  const worktree = join(root, 'native', '.build', 'release', 'dsh-computer-helper')
  try {
    await fakeHelper(worktree)
    const cacheRoot = join(root, 'cache')
    const helper = new NativeHelper({ packageRoot: root, stableBinaryPath: stable, cacheRoot, platform: 'darwin' })
    const status = await helper.request({ id: 'status', command: 'status' }, { scopeId: 'resolver' })
    assert.equal(status.resolution.source, 'worktree-build')
    assert.equal(status.identityStable, false)
    assert.notEqual(status.helperExecutable, worktree, 'worktree artifacts are staged before execution')
    assert.match(status.helperExecutable, /\/cache\/worktree-signed-[a-f0-9]{20}\/dsh-computer-helper$/u)
    await access(status.helperExecutable)
    await helper.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an invalid fixed app fails closed instead of silently falling back to a worktree helper', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-computer-resolver-invalid-'))
  const stable = join(root, 'DSH Computer Helper.app', 'Contents', 'MacOS', 'dsh-computer-helper')
  const worktree = join(root, 'native', '.build', 'release', 'dsh-computer-helper')
  try {
    await Promise.all([fakeHelper(stable), fakeHelper(worktree)])
    const helper = new NativeHelper({ packageRoot: root, stableBinaryPath: stable, platform: 'darwin' })
    await assert.rejects(
      helper.request({ id: 'status', command: 'status' }, { scopeId: 'resolver' }),
      error => error?.code === 'helper_identity_invalid' && /signature|signing identity/u.test(error.message),
    )
    await helper.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the fixed app resolver rejects symlinked bundle components before execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-computer-resolver-symlink-'))
  const real = join(root, 'real-helper')
  const stable = join(root, 'DSH Computer Helper.app', 'Contents', 'MacOS', 'dsh-computer-helper')
  try {
    await fakeHelper(real)
    await mkdir(dirname(stable), { recursive: true })
    await symlink(real, stable)
    const helper = new NativeHelper({ packageRoot: root, stableBinaryPath: stable, platform: 'darwin' })
    await assert.rejects(
      helper.request({ id: 'status', command: 'status' }, { scopeId: 'resolver' }),
      error => error?.code === 'helper_identity_invalid' && /symbolic link/u.test(error.message),
    )
    await helper.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('first-use Swift build abort is killed and awaited before request rejection', async () => {
  const files = await fixture()
  const priorPath = process.env.PATH
  const priorMarker = process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER
  process.env.PATH = `${files.bin}${delimiter}${priorPath ?? ''}`
  process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER = files.marker
  try {
    const helper = new NativeHelper({
      packageRoot: files.root, stableBinaryPath: join(files.root, 'missing-stable'),
      cacheRoot: join(files.root, 'cache'), platform: 'darwin',
    })
    const abort = new AbortController()
    const pending = helper.request(
      { id: 'status', command: 'status' }, { scopeId: 'agent-a', signal: abort.signal },
    )
    await waitFor(files.marker)
    abort.abort(new Error('test cancellation'))
    await assert.rejects(pending, /test cancellation/)
    await waitFor(`${files.marker}.terminated`)
    assert.equal(helper.active('agent-a'), 0)
    await helper.dispose()
  } finally {
    if (priorPath === undefined) delete process.env.PATH
    else process.env.PATH = priorPath
    if (priorMarker === undefined) delete process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER
    else process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER = priorMarker
    await rm(files.root, { recursive: true, force: true })
  }
})

test('dispose fences a running first-use build and waits for quiescence', async () => {
  const files = await fixture()
  const priorPath = process.env.PATH
  const priorMarker = process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER
  process.env.PATH = `${files.bin}${delimiter}${priorPath ?? ''}`
  process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER = files.marker
  try {
    const helper = new NativeHelper({
      packageRoot: files.root, stableBinaryPath: join(files.root, 'missing-stable'),
      cacheRoot: join(files.root, 'cache'), platform: 'darwin',
    })
    const pending = helper.request({ id: 'status', command: 'status' }, { scopeId: 'agent-a' })
    await waitFor(files.marker)
    await helper.dispose()
    await assert.rejects(pending, /disposed/)
    await waitFor(`${files.marker}.terminated`)
    assert.equal(helper.active('agent-a'), 0)
    await assert.rejects(
      helper.request({ id: 'again', command: 'status' }, { scopeId: 'agent-a' }),
      /disposed/,
    )
  } finally {
    if (priorPath === undefined) delete process.env.PATH
    else process.env.PATH = priorPath
    if (priorMarker === undefined) delete process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER
    else process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER = priorMarker
    await rm(files.root, { recursive: true, force: true })
  }
})

test('disposeScope aborts and awaits a scope-owned first-use build', async () => {
  const files = await fixture()
  const priorPath = process.env.PATH
  const priorMarker = process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER
  process.env.PATH = `${files.bin}${delimiter}${priorPath ?? ''}`
  process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER = files.marker
  try {
    const helper = new NativeHelper({
      packageRoot: files.root, stableBinaryPath: join(files.root, 'missing-stable'),
      cacheRoot: join(files.root, 'cache'), platform: 'darwin',
    })
    const pending = helper.request({ id: 'status', command: 'status' }, { scopeId: 'agent-a' })
    await waitFor(files.marker)
    await helper.disposeScope('agent-a')
    await assert.rejects(pending, /scope disposed/)
    await waitFor(`${files.marker}.terminated`)
    assert.equal(helper.active('agent-a'), 0)
    await helper.dispose()
  } finally {
    if (priorPath === undefined) delete process.env.PATH
    else process.env.PATH = priorPath
    if (priorMarker === undefined) delete process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER
    else process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER = priorMarker
    await rm(files.root, { recursive: true, force: true })
  }
})

test('canceling one of two build waiters does not abort the other Agent', async () => {
  const files = await fixture()
  const priorPath = process.env.PATH
  const priorMarker = process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER
  process.env.PATH = `${files.bin}${delimiter}${priorPath ?? ''}`
  process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER = files.marker
  try {
    const helper = new NativeHelper({
      packageRoot: files.root, stableBinaryPath: join(files.root, 'missing-stable'),
      cacheRoot: join(files.root, 'cache'), platform: 'darwin',
    })
    const abortA = new AbortController()
    const abortB = new AbortController()
    const pendingA = helper.request(
      { id: 'a', command: 'status' }, { scopeId: 'agent-a', signal: abortA.signal },
    )
    const pendingB = helper.request(
      { id: 'b', command: 'status' }, { scopeId: 'agent-b', signal: abortB.signal },
    )
    await waitFor(files.marker)
    assert.equal(helper.active('agent-a'), 1)
    assert.equal(helper.active('agent-b'), 1)

    abortA.abort(new Error('cancel agent-a'))
    await assert.rejects(pendingA, /cancel agent-a/)
    await new Promise(resolve => setTimeout(resolve, 100))
    await assert.rejects(access(`${files.marker}.terminated`), error => error?.code === 'ENOENT')
    assert.equal(helper.active('agent-b'), 1)

    abortB.abort(new Error('cancel final waiter'))
    await assert.rejects(pendingB, /cancel final waiter/)
    await waitFor(`${files.marker}.terminated`)
    assert.equal(helper.active('agent-b'), 0)
    await helper.dispose()
  } finally {
    if (priorPath === undefined) delete process.env.PATH
    else process.env.PATH = priorPath
    if (priorMarker === undefined) delete process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER
    else process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER = priorMarker
    await rm(files.root, { recursive: true, force: true })
  }
})

test('disposing scope A leaves scope B waiting; disposing the final waiter aborts the build', async () => {
  const files = await fixture()
  const priorPath = process.env.PATH
  const priorMarker = process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER
  process.env.PATH = `${files.bin}${delimiter}${priorPath ?? ''}`
  process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER = files.marker
  try {
    const helper = new NativeHelper({
      packageRoot: files.root, stableBinaryPath: join(files.root, 'missing-stable'),
      cacheRoot: join(files.root, 'cache'), platform: 'darwin',
    })
    const pendingA = helper.request({ id: 'a', command: 'status' }, { scopeId: 'agent-a' })
    const pendingB = helper.request({ id: 'b', command: 'status' }, { scopeId: 'agent-b' })
    await waitFor(files.marker)

    await helper.disposeScope('agent-a')
    await assert.rejects(pendingA, /scope disposed: agent-a/)
    await new Promise(resolve => setTimeout(resolve, 100))
    await assert.rejects(access(`${files.marker}.terminated`), error => error?.code === 'ENOENT')
    assert.equal(helper.active('agent-b'), 1)

    await helper.disposeScope('agent-b')
    await assert.rejects(pendingB, /scope disposed: agent-b/)
    await waitFor(`${files.marker}.terminated`)
    assert.equal(helper.active('agent-b'), 0)
    await helper.dispose()
  } finally {
    if (priorPath === undefined) delete process.env.PATH
    else process.env.PATH = priorPath
    if (priorMarker === undefined) delete process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER
    else process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER = priorMarker
    await rm(files.root, { recursive: true, force: true })
  }
})

test('late Agents wait out final-waiter cancellation and share exactly one fresh build', async () => {
  const files = await fixture()
  const priorPath = process.env.PATH
  const priorMarker = process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER
  const priorMode = process.env.DSH_COMPUTER_FAKE_SWIFT_MODE
  process.env.PATH = `${files.bin}${delimiter}${priorPath ?? ''}`
  process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER = files.marker
  process.env.DSH_COMPUTER_FAKE_SWIFT_MODE = 'hang-once-then-succeed'
  try {
    const helper = new NativeHelper({
      packageRoot: files.root, stableBinaryPath: join(files.root, 'missing-stable'),
      cacheRoot: join(files.root, 'cache'), platform: 'darwin',
    })
    const abortA = new AbortController()
    const pendingA = helper.request(
      { id: 'a', command: 'status' }, { scopeId: 'agent-a', signal: abortA.signal },
    )
    await waitFor(files.marker)
    abortA.abort(new Error('cancel final waiter A'))
    const rejectedA = assert.rejects(pendingA, /cancel final waiter A/u)
    await waitFor(`${files.marker}.terminating`)

    // This request lands while the first compiler has acknowledged SIGTERM but
    // has deliberately not exited. It must not subscribe to A's rejected promise.
    const pendingB = helper.request({ id: 'b', command: 'status' }, { scopeId: 'agent-b' })
    const pendingC = helper.request({ id: 'c', command: 'status' }, { scopeId: 'agent-c' })
    await rejectedA
    const [statusB, statusC] = await Promise.all([pendingB, pendingC])
    assert.equal(statusB.helperVersion, '0.1.0-rc.1')
    assert.equal(statusB.resolution.source, 'cache-build')
    assert.equal(statusB.identityStable, false)
    assert.equal(statusC.resolution.selectedPath, statusB.resolution.selectedPath)
    await waitFor(`${files.marker}.second-started`)
    assert.equal(Number.parseInt(await readFile(`${files.marker}.count`, 'utf8'), 10), 3)
    assert.equal(helper.active('agent-a'), 0)
    assert.equal(helper.active('agent-b'), 0)
    assert.equal(helper.active('agent-c'), 0)
    await helper.dispose()
  } finally {
    if (priorPath === undefined) delete process.env.PATH
    else process.env.PATH = priorPath
    if (priorMarker === undefined) delete process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER
    else process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER = priorMarker
    if (priorMode === undefined) delete process.env.DSH_COMPUTER_FAKE_SWIFT_MODE
    else process.env.DSH_COMPUTER_FAKE_SWIFT_MODE = priorMode
    await rm(files.root, { recursive: true, force: true })
  }
})

test('a late Agent also escapes a closing build caused by final scope disposal', async () => {
  const files = await fixture()
  const priorPath = process.env.PATH
  const priorMarker = process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER
  const priorMode = process.env.DSH_COMPUTER_FAKE_SWIFT_MODE
  process.env.PATH = `${files.bin}${delimiter}${priorPath ?? ''}`
  process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER = files.marker
  process.env.DSH_COMPUTER_FAKE_SWIFT_MODE = 'hang-once-then-succeed'
  try {
    const helper = new NativeHelper({
      packageRoot: files.root, stableBinaryPath: join(files.root, 'missing-stable'),
      cacheRoot: join(files.root, 'cache'), platform: 'darwin',
    })
    const pendingA = helper.request({ id: 'a', command: 'status' }, { scopeId: 'agent-a' })
    await waitFor(files.marker)
    const disposingA = helper.disposeScope('agent-a')
    const rejectedA = assert.rejects(pendingA, /scope disposed: agent-a/u)
    await waitFor(`${files.marker}.terminating`)

    const pendingB = helper.request({ id: 'b', command: 'status' }, { scopeId: 'agent-b' })
    await disposingA
    await rejectedA
    const statusB = await pendingB
    assert.equal(statusB.helperVersion, '0.1.0-rc.1')
    assert.equal(statusB.resolution.source, 'cache-build')
    assert.equal(statusB.identityStable, false)
    await waitFor(`${files.marker}.second-started`)
    assert.equal(helper.active('agent-a'), 0)
    assert.equal(helper.active('agent-b'), 0)
    await helper.dispose()
  } finally {
    if (priorPath === undefined) delete process.env.PATH
    else process.env.PATH = priorPath
    if (priorMarker === undefined) delete process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER
    else process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER = priorMarker
    if (priorMode === undefined) delete process.env.DSH_COMPUTER_FAKE_SWIFT_MODE
    else process.env.DSH_COMPUTER_FAKE_SWIFT_MODE = priorMode
    await rm(files.root, { recursive: true, force: true })
  }
})
