// Field report (session.v3, 2026-09-24): 17 of 24 approval prompts were bash
// sandbox escalations the model used to open an app or find its window number,
// because dsh-computer had no way to do either. computer_apps/computer_launch
// close that gap without a shell and without an approval.
import assert from 'node:assert/strict'
import test from 'node:test'
import { ComputerController, createComputerTools } from '../lib/index.js'

const calculator = {
  bundleId: 'com.apple.calculator', pid: 501, launchIdentity: '1:/Calculator', name: '计算器', active: true,
  windows: [{ number: 96480, title: '计算器', frame: { x: 1470, y: 1055, width: 230, height: 408 } }],
}

function nativeReplying(result) {
  return {
    requests: [],
    async request(request) { this.requests.push(structuredClone(request)); return structuredClone(result) },
    active() { return 0 }, async disposeScope() {}, async dispose() {},
  }
}

const exec = { callId: 'c', signal: new AbortController().signal, agent: { id: 'agent-a' } }

test('computer_launch sends only an exact bundle id and needs no approval', async () => {
  const native = nativeReplying({ launched: true, app: calculator })
  let approvals = 0
  const tools = createComputerTools(new ComputerController({ native, platform: 'darwin' }), {
    getApproval: () => { approvals += 1; return undefined },
  })
  const result = await tools.computerLaunch.execute({ app_bundle_id: 'com.apple.calculator' }, exec)
  assert.equal(result.launched, true)
  assert.equal(result.app.windows[0].number, 96480)
  assert.equal(native.requests.length, 1)
  assert.deepEqual(native.requests[0].launch, { bundleId: 'com.apple.calculator' })
  assert.equal(native.requests[0].command, 'launch')
  assert.equal(approvals, 0)
})

test('computer_launch rejects paths, URLs, display names and extra arguments before the helper', async () => {
  const native = nativeReplying({ launched: true, app: calculator })
  const tools = createComputerTools(new ComputerController({ native, platform: 'darwin' }))
  for (const bad of ['/Applications/Calculator.app', 'file:///Applications/Calculator.app', 'Calculator', 'com.apple.calculator; rm -rf ~', '-a.b', '']) {
    await assert.rejects(tools.computerLaunch.execute({ app_bundle_id: bad }, exec), undefined, bad)
  }
  await assert.rejects(tools.computerLaunch.execute({ app_bundle_id: 'com.apple.calculator', args: ['--x'] }, exec), /args/u)
  assert.equal(native.requests.length, 0)
})

test('computer_launch refuses a helper reply for a different app', async () => {
  const native = nativeReplying({ launched: true, app: { ...calculator, bundleId: 'com.apple.Terminal' } })
  const tools = createComputerTools(new ComputerController({ native, platform: 'darwin' }))
  await assert.rejects(tools.computerLaunch.execute({ app_bundle_id: 'com.apple.calculator' }, exec), /expected com\.apple\.calculator/u)
})

test('computer_apps returns window numbers usable as computer_observe window_number', async () => {
  const native = nativeReplying({ apps: [calculator], truncated: false, accessibilityTrusted: true })
  const tools = createComputerTools(new ComputerController({ native, platform: 'darwin' }))
  const result = await tools.computerApps.execute({}, exec)
  assert.deepEqual(result, { apps: [calculator], truncated: false, accessibilityTrusted: true })
  assert.equal(native.requests[0].command, 'apps')
  await assert.rejects(tools.computerApps.execute({ filter: 'x' }, exec), /filter/u)
})

test('computer_apps rejects a malformed helper list', async () => {
  const native = nativeReplying({ apps: [{ bundleId: 'x.y' }], truncated: false, accessibilityTrusted: true })
  const tools = createComputerTools(new ComputerController({ native, platform: 'darwin' }))
  await assert.rejects(tools.computerApps.execute({}, exec), /malformed/u)
})

test('act and observe descriptions steer away from printable key chords and shell launching', () => {
  const tools = createComputerTools(new ComputerController({ native: nativeReplying({}), platform: 'darwin' }))
  assert.match(tools.computerAct.description, /click the on-screen button or use action=type/u)
  assert.match(tools.computerAct.parameters.properties.key.description, /single printable characters/u)
  assert.match(tools.computerObserve.description, /computer_apps/u)
  assert.match(tools.computerLaunch.description, /instead of shell `open -a`/u)
})
