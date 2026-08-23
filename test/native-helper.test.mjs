import assert from 'node:assert/strict'
import { access, chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
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

test('first-use Swift build abort is killed and awaited before request rejection', async () => {
  const files = await fixture()
  const priorPath = process.env.PATH
  const priorMarker = process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER
  process.env.PATH = `${files.bin}${delimiter}${priorPath ?? ''}`
  process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER = files.marker
  try {
    const helper = new NativeHelper({
      packageRoot: files.root, cacheRoot: join(files.root, 'cache'), platform: 'darwin',
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
      packageRoot: files.root, cacheRoot: join(files.root, 'cache'), platform: 'darwin',
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
      packageRoot: files.root, cacheRoot: join(files.root, 'cache'), platform: 'darwin',
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
      packageRoot: files.root, cacheRoot: join(files.root, 'cache'), platform: 'darwin',
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
      packageRoot: files.root, cacheRoot: join(files.root, 'cache'), platform: 'darwin',
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
