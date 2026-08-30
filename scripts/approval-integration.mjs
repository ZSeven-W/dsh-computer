import { spawn, spawnSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComputerController, NativeHelper } from '../lib/index.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bundleId = 'dev.zseven.fixture'
const scopeId = 'approval-integration'
const publishName = 'Publish release'
const publishedIdentifier = 'published-count'
// The approval gate holds longer than the observation TTL, proving that a
// human's deliberation time no longer consumes the freshness budget.
const ttlMs = 2_000
const approvalDelayMs = 3_000

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      ...options,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`${command} ${args.join(' ')} exited ${code}: ${stdout}${stderr}`))
      resolvePromise(stdout)
    })
  })
}

function spawnDetached(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', shell: false, detached: true })
    child.on('error', reject)
    child.on('spawn', () => { child.unref(); resolvePromise(child) })
  })
}

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.zseven.fixture</string>
  <key>CFBundleName</key><string>Fixture</string>
  <key>CFBundleExecutable</key><string>Fixture</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict>
</plist>
`

function failLoud(message) {
  console.error(`[approval-integration] FAILED: ${message}`)
  console.error('[approval-integration] Actionable: enable Accessibility for DSH Computer Helper in System Settings > Privacy & Security > Accessibility, then unlock the desktop and retry.')
  process.exit(1)
}

async function buildFixture() {
  const tmpRoot = join(root, '.tmp')
  const clangCache = join(tmpRoot, 'clang-module-cache')
  const app = join(tmpRoot, 'Fixture.app')
  await rm(app, { recursive: true, force: true })
  await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true })
  await writeFile(join(app, 'Contents', 'Info.plist'), INFO_PLIST)
  const swiftc = spawnSync('swiftc', ['-O', '-o', join(app, 'Contents', 'MacOS', 'Fixture'), join(root, 'native', 'FixtureApp', 'main.swift')], {
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: tmpRoot, CLANG_MODULE_CACHE_PATH: clangCache },
  })
  if (swiftc.status !== 0) throw new Error(`fixture build failed: ${swiftc.stdout}${swiftc.stderr}`)
  await run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', bundleId, app])
  return app
}

async function waitForFixture(controller, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try {
      const observation = await controller.observe(
        { app: { bundleId }, maxDepth: 8, maxNodes: 300, ttlMs: 15_000 },
        { scopeId },
      )
      return observation
    } catch (error) {
      lastError = error
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
    }
  }
  throw new Error(`fixture app did not become observable within ${timeoutMs}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
}

function publishedCount(targets) {
  return targets.find(target => target.identifier === publishedIdentifier)?.value ?? null
}

async function main() {
  if (process.platform !== 'darwin') {
    console.log('[approval-integration] skipped: requires macOS Accessibility')
    return
  }

  const cacheRoot = join(root, '.tmp', 'helper-cache')
  const controller = new ComputerController({ native: new NativeHelper({ packageRoot: root, cacheRoot }) })

  try {
    const evidence = await controller.evidence({ scopeId })
    const status = evidence.status
    console.log(`[approval-integration] helper: ${status.helperVersion} accessibilityTrusted=${status.accessibilityTrusted} screenRecordingTrusted=${status.screenRecordingTrusted} sessionLocked=${status.sessionLocked} interactiveSessionAvailable=${status.interactiveSessionAvailable}`)
    if (status.accessibilityTrusted !== true) {
      failLoud('Accessibility is not granted to DSH Computer Helper; approval/act cannot run.')
    }
    if (status.interactiveSessionAvailable !== true) {
      failLoud('macOS interactive desktop session is locked or unavailable.')
    }

    try { spawnSync('/usr/bin/pkill', ['-f', 'Fixture.app/Contents/MacOS/Fixture']) } catch { /* none running */ }
    const app = await buildFixture()
    await run('/usr/bin/open', ['-n', app])
    console.log(`[approval-integration] launched fixture ${app}`)

    await waitForFixture(controller)

    // A fresh, short-TTL observation immediately before the act: the approval
    // gate's delay provably outlives this observation's freshness budget.
    const before = await controller.observe(
      { app: { bundleId }, maxDepth: 8, maxNodes: 300, ttlMs },
      { scopeId },
    )
    const publishButton = before.targets.find(target => target.name === publishName && target.actions.includes('AXPress'))
    if (!publishButton) failLoud(`fixture observation is missing the '${publishName}' button`)
    const initialCount = publishedCount(before.targets)
    console.log(`[approval-integration] initial published count=${JSON.stringify(initialCount)}`)

    const receipt = await controller.act(
      { kind: 'click', ref: publishButton.ref },
      {
        scopeId,
        approval: {
          async request(reason) {
            console.log(`[approval-integration] approval prompt: ${reason}`)
            await new Promise(resolvePromise => setTimeout(resolvePromise, approvalDelayMs))
            return 'allowed-once'
          },
        },
      },
    )
    console.log(`[approval-integration] click receipt status=${receipt.status} nativeAccepted=${receipt.nativeAccepted} reason=${receipt.reason}`)
    if (receipt.status !== 'unknown') {
      failLoud(`expected an honest unknown click receipt, got ${JSON.stringify({ status: receipt.status, reason: receipt.reason })}`)
    }
    if (receipt.nativeAccepted !== true) {
      failLoud(`expected the approved click to be native-accepted, got nativeAccepted=${receipt.nativeAccepted}`)
    }

    await new Promise(resolvePromise => setTimeout(resolvePromise, 300))
    const after = await controller.observe(
      { app: { bundleId }, maxDepth: 8, maxNodes: 300, ttlMs: 15_000 },
      { scopeId },
    )
    const finalCount = publishedCount(after.targets)
    console.log(`[approval-integration] final published count=${JSON.stringify(finalCount)}`)
    if (finalCount !== 'PUBLISHED: 1') {
      failLoud(`PUBLISHED did not advance by exactly 1 (got ${JSON.stringify(finalCount)})`)
    }

    console.log(JSON.stringify({
      ok: true,
      helperVersion: evidence.status.helperVersion,
      ttlMs,
      approvalDelayMs,
      receiptStatus: receipt.status,
      nativeAccepted: receipt.nativeAccepted,
      initialPublished: initialCount,
      finalPublished: finalCount,
    }, null, 2))
  } finally {
    await controller.dispose()
    try { spawnSync('/usr/bin/pkill', ['-f', 'Fixture.app/Contents/MacOS/Fixture']) } catch { /* already gone */ }
    try { await rm(join(root, '.tmp', 'helper-cache'), { recursive: true, force: true }) } catch { /* cleanup best-effort */ }
  }
}

main().catch(error => {
  console.error('[approval-integration] FAILED:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
