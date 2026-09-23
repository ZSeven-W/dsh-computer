import { access, chmod, copyFile, mkdtemp, readFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.platform !== 'darwin') {
  console.log(`native protocol smoke skipped on ${process.platform}`)
  process.exit(0)
}

const candidates = [
  join('native', '.build', 'release', 'dsh-computer-helper'),
  join('native', '.build', 'debug', 'dsh-computer-helper'),
]
let sourceBinary
for (const candidate of candidates) {
  try { await access(candidate); sourceBinary = candidate; break } catch { /* try next build configuration */ }
}
if (!sourceBinary) throw new Error('native helper binary not found; run swift build or swift test first')

// Match production's development path: never execute SwiftPM's worktree
// artifact in place. A fixed-identifier ad-hoc signature needs no keychain and
// avoids macOS provenance/Gatekeeper holding the process before main.
const scratch = await mkdtemp(join(tmpdir(), 'dsh-computer-protocol-'))
const binary = join(scratch, 'dsh-computer-helper')
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))
await copyFile(sourceBinary, binary)
await chmod(binary, 0o755)
const signed = spawnSync('/usr/bin/codesign', [
  '--force', '--identifier', 'io.github.zseven-w.dsh-computer.development-helper',
  '--sign', '-', binary,
], { encoding: 'utf8' })
if (signed.status !== 0) {
  throw new Error(`could not ad-hoc sign protocol Helper: ${signed.stdout}${signed.stderr}`)
}

// Source-order regression guard for the two multi-step mutation paths. This
// exercises no UI action: it proves the session guard stays between a successful
// focus mutation and the subsequent value/key mutation in the built source.
const helperSource = await readFile(join('native', 'Sources', 'DSHComputerHelper', 'main.swift'), 'utf8')
function requireOrdered(label, start, orderedNeedles) {
  let cursor = helperSource.indexOf(start)
  if (cursor < 0) throw new Error(`${label} start marker is missing`)
  for (const needle of orderedNeedles) {
    const next = helperSource.indexOf(needle, cursor + 1)
    if (next < 0) throw new Error(`${label} is missing ordered marker: ${needle}`)
    cursor = next
  }
}
requireOrdered('type lock-transition guard', 'reason: "focus mutation began before typing', [
  'try requireInteractiveSession()',
  'let valueCode = AXUIElementSetAttributeValue',
])
requireOrdered('key lock-transition guard', 'reason: "focus mutation began before key dispatch', [
  'try requireInteractiveSession()',
  'preparedKey.down.postToPid',
])

function requireOwn(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object: ${JSON.stringify(value)}`)
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`${label} omitted required key ${key}: ${JSON.stringify(value)}`)
    }
  }
}

function requireProtocolIdentityShape(app, window, label) {
  requireOwn(app, ['bundleId', 'pid', 'launchIdentity', 'name'], `${label}.app`)
  requireOwn(window, ['number', 'role', 'subrole', 'title', 'frame', 'identity'], `${label}.window`)
}

function requireElementShape(element, label) {
  requireOwn(
    element,
    ['role', 'subrole', 'name', 'identifier', 'frame', 'enabled', 'focused', 'secure', 'actions', 'value'],
    label,
  )
}

function request(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`helper exited ${code}: ${stderr}`))
      try { resolve(JSON.parse(stdout.trim())) } catch { reject(new Error(`invalid helper JSON: ${stdout}`)) }
    })
    child.stdin.end(`${JSON.stringify(payload)}\n`)
  })
}

const status = await request({ id: 'status-smoke', command: 'status' })
if (!status.ok || status.result?.platform !== 'macos' || typeof status.result?.accessibilityTrusted !== 'boolean') {
  throw new Error(`unexpected status response: ${JSON.stringify(status)}`)
}
requireOwn(status.result, [
  'platform', 'accessibilityTrusted', 'screenRecordingTrusted', 'helperVersion', 'helperExecutable',
  'sessionLocked', 'interactiveSessionAvailable',
  'bundle', 'signing', 'process', 'caller', 'resolution', 'identityStable',
], 'status.result')
if (typeof status.result.sessionLocked !== 'boolean'
  || typeof status.result.interactiveSessionAvailable !== 'boolean'
  || (status.result.sessionLocked && status.result.interactiveSessionAvailable)) {
  throw new Error(`invalid interactive-session status: ${JSON.stringify(status.result)}`)
}
requireOwn(status.result.bundle, ['path', 'identifier', 'version'], 'status.result.bundle')
requireOwn(status.result.signing, [
  'signed', 'kind', 'codeIdentifier', 'teamIdentifier', 'authorities', 'cdhash', 'statusCode', 'detail',
], 'status.result.signing')
requireOwn(status.result.caller, ['pid', 'executable', 'bundleIdentifier', 'name'], 'status.result.caller')

const observe = await request({
  id: 'observe-smoke', command: 'observe', app: null, window: null, maxDepth: 1, maxNodes: 4,
})
// This smoke validates the PROTOCOL SHAPE, not that some application happens
// to have a window. `app: null` observes whatever is frontmost, and on a real
// machine that can legitimately be something the AX API exposes no windows for
// — a GPU-rendered terminal (Warp), a fullscreen app, the login window — and
// on a CI runner there is usually no windowed app at all. Those states must be
// tolerated the same way a missing grant or a locked session is, or the gate
// fails for a reason that says nothing about the helper. What is NOT relaxed:
// every field assertion below still runs whenever the observe DID succeed.
const OBSERVE_ENVIRONMENT_CODES = [
  'accessibility_permission_required',
  'session_locked',
  'window_not_found',
]
// A tolerated code is never silent: the summary at the end of this script
// prints `boundedObserve: { ok: false, code }`, so a green run always says
// whether the observe actually ran.
if (!observe.ok && !OBSERVE_ENVIRONMENT_CODES.includes(observe.error?.code)) {
  throw new Error(`unexpected bounded observation response: ${JSON.stringify(observe)}`)
}
if (observe.ok) {
  requireOwn(observe.result, ['capturedAt', 'app', 'window', 'nodes', 'truncated'], 'observe.result')
  requireProtocolIdentityShape(observe.result.app, observe.result.window, 'observe.result')
  if (!Array.isArray(observe.result.nodes) || observe.result.nodes.length === 0) {
    throw new Error(`successful observe did not return the root window node: ${JSON.stringify(observe)}`)
  }
  for (const [index, node] of observe.result.nodes.entries()) {
    requireElementShape(node, `observe.result.nodes[${index}]`)
    requireOwn(node, ['locator', 'depth'], `observe.result.nodes[${index}]`)
  }
  // JSON.stringify is the same boundary used by the tool-result transport.
  const roundTrip = JSON.parse(JSON.stringify(observe.result))
  requireProtocolIdentityShape(roundTrip.app, roundTrip.window, 'observe.stringifyRoundTrip')
  requireElementShape(roundTrip.nodes[0], 'observe.stringifyRoundTrip.nodes[0]')
}

// Decode a real host-shaped grant without providing a target. actionResult
// rejects before preflight, so this exercises no Accessibility/CG mutation.
const validGrant = {
  outcome: 'allowed-once',
  observationId: 'obs_protocol-smoke',
  observationFingerprint: 'a'.repeat(64),
  riskCode: 'dangerous-click',
  actionDigest: 'fa80c81977738372f15520edacfcee5d110152a43b1c7d971835f85644fd0cc4',
  nonce: 'A'.repeat(43),
  refDigest: 'b'.repeat(64),
}
const decodedGrant = await request({
  id: 'approval-decode-smoke', command: 'act', expected: null, action: { kind: 'click' }, approval: validGrant,
})
if (!decodedGrant.ok || decodedGrant.result?.status !== 'rejected' || decodedGrant.result?.accepted !== false) {
  throw new Error(`unexpected valid approval decode response: ${JSON.stringify(decodedGrant)}`)
}
requireOwn(decodedGrant.result, ['status', 'reason', 'accepted', 'post'], 'approvalDecode.result')
if (decodedGrant.result.post !== null) {
  throw new Error(`act rejection must encode post as explicit null: ${JSON.stringify(decodedGrant)}`)
}

const privateSentinel = 'PRIVATE-GRANT-SENTINEL'
const invalidGrant = await request({
  id: 'approval-invalid-smoke', command: 'act', expected: null, action: { kind: 'click' },
  approval: { ...validGrant, nonce: privateSentinel },
})
const invalidGrantText = JSON.stringify(invalidGrant)
if (invalidGrant.ok || invalidGrant.error?.code !== 'invalid_request' || invalidGrantText.includes(privateSentinel)) {
  throw new Error(`invalid approval did not fail closed without reflection: ${invalidGrantText}`)
}
// App discovery is read-only and needs no grant, so it must succeed anywhere.
const apps = await request({ id: 'apps-smoke', command: 'apps' })
if (!apps.ok || !Array.isArray(apps.result?.apps) || typeof apps.result.truncated !== 'boolean'
  || apps.result.accessibilityTrusted !== status.result.accessibilityTrusted) {
  throw new Error(`unexpected apps response: ${JSON.stringify(apps)}`)
}
for (const [index, app] of apps.result.apps.entries()) {
  requireOwn(app, ['bundleId', 'pid', 'launchIdentity', 'name', 'active', 'windows'], `apps.result.apps[${index}]`)
  if (!apps.result.accessibilityTrusted && app.windows.length !== 0) {
    throw new Error(`apps listed windows without Accessibility trust: ${JSON.stringify(app)}`)
  }
  for (const window of app.windows) requireOwn(window, ['number', 'title', 'frame'], `apps.result.apps[${index}].windows`)
}
// Launch is exercised only on inputs that must never open anything.
for (const [bundleId, code] of [
  ['/System/Applications/Calculator.app', 'invalid_request'],
  ['file:///System/Applications/Calculator.app', 'invalid_request'],
  ['dev.zseven.dsh-computer.no-such-app', 'application_not_installed'],
]) {
  const launch = await request({ id: 'launch-smoke', command: 'launch', launch: { bundleId } })
  if (launch.ok || launch.error?.code !== code) {
    throw new Error(`launch of ${bundleId} did not fail with ${code}: ${JSON.stringify(launch)}`)
  }
}

console.log(JSON.stringify({
  appDiscovery: { apps: apps.result.apps.length, accessibilityTrusted: apps.result.accessibilityTrusted },
  nativeStatus: status.result,
  approvalDecode: { validRejectedBeforePreflight: true, invalidFailedClosed: true },
  boundedObserve: observe.ok
    ? { ok: true, nodes: observe.result.nodes.length, truncated: observe.result.truncated }
    : { ok: false, code: observe.error.code },
}))
