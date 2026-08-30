import { spawn, spawnSync } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComputerController, NativeHelper } from '../lib/index.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bundleId = 'dev.zseven.fixture'
const targetRowTitle = 'Target Row 57'
const statusIdentifier = 'status-label'
const scopeId = 'scroll-integration'

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

function fixtureTargets(observation) {
  const scrollArea = observation.targets.find(target => target.role === 'AXScrollArea')
  const targetRow = observation.targets.find(target => target.name === targetRowTitle && target.actions.includes('AXPress'))
  const status = observation.targets.find(target => target.identifier === statusIdentifier)
  return { scrollArea, targetRow, status }
}

function frameVisibleWithin(target, scrollArea) {
  if (!target?.frame || !scrollArea?.frame) return false
  const { y } = target.frame
  const top = scrollArea.frame.y
  const bottom = scrollArea.frame.y + scrollArea.frame.height
  return y >= top - 1 && y <= bottom
}

function failLoud(message) {
  console.error(`[scroll-integration] FAILED: ${message}`)
  console.error('[scroll-integration] Actionable: enable Accessibility for DSH Computer Helper in System Settings > Privacy & Security > Accessibility, then unlock the desktop and retry.')
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

async function main() {
  if (process.platform !== 'darwin') {
    console.log('[scroll-integration] skipped: requires macOS Accessibility')
    return
  }

  const cacheRoot = join(root, '.tmp', 'helper-cache')
  const controller = new ComputerController({ native: new NativeHelper({ packageRoot: root, cacheRoot }) })

  let helperPid
  try {
    const evidence = await controller.evidence({ scopeId })
    const status = evidence.status
    console.log(`[scroll-integration] helper: ${status.helperVersion} accessibilityTrusted=${status.accessibilityTrusted} screenRecordingTrusted=${status.screenRecordingTrusted} sessionLocked=${status.sessionLocked} interactiveSessionAvailable=${status.interactiveSessionAvailable}`)
    if (status.accessibilityTrusted !== true) {
      failLoud('Accessibility is not granted to DSH Computer Helper; scroll/observe/act cannot run.')
    }
    if (status.interactiveSessionAvailable !== true) {
      failLoud('macOS interactive desktop session is locked or unavailable.')
    }

    // Terminate any stale fixture instance, then build and launch a fresh one.
    try { spawnSync('/usr/bin/pkill', ['-f', 'Fixture.app/Contents/MacOS/Fixture']) } catch { /* none running */ }
    const app = await buildFixture()
    await run('/usr/bin/open', ['-n', app])
    console.log(`[scroll-integration] launched fixture ${app}`)

    const initial = await waitForFixture(controller)
    let targets = fixtureTargets(initial)
    if (!targets.scrollArea) failLoud('fixture observation exposes no AXScrollArea')
    if (!targets.targetRow) failLoud(`fixture observation is missing the target row '${targetRowTitle}'`)
    if (!targets.status) failLoud('fixture observation is missing the status label')
    console.log(`[scroll-integration] initial: status=${JSON.stringify(targets.status.value)} scrollArea=${JSON.stringify(targets.scrollArea.frame)} targetRow y=${targets.targetRow.frame?.y} (below viewport=${!frameVisibleWithin(targets.targetRow, targets.scrollArea)})`)

    if (frameVisibleWithin(targets.targetRow, targets.scrollArea)) {
      failLoud('fixture target row is unexpectedly already inside the visible area')
    }

    // Scroll down a page at a time until the target row enters the visible area.
    let visible = false
    let scrolls = 0
    const receipts = []
    for (; scrolls < 12; scrolls += 1) {
      const receipt = await controller.act(
        { kind: 'scroll', ref: targets.scrollArea.ref, direction: 'down', amount: 'page' },
        { scopeId },
      )
      receipts.push(receipt)
      if (receipt.status !== 'unknown') failLoud(`scroll receipt was not honest-unknown: ${JSON.stringify(receipt)}`)
      const refreshed = await controller.observe(
        { app: { bundleId }, maxDepth: 8, maxNodes: 300, ttlMs: 15_000 },
        { scopeId },
      )
      targets = fixtureTargets(refreshed)
      if (!targets.targetRow) failLoud('target row disappeared after scrolling')
      if (frameVisibleWithin(targets.targetRow, targets.scrollArea)) { visible = true; break }
    }
    if (!visible) failLoud(`target row '${targetRowTitle}' did not become visible within ${scrolls} page scrolls`)
    console.log(`[scroll-integration] scrolled ${scrolls + 1} page(s); target row y=${targets.targetRow.frame?.y} (visible=true)`)

    // Click the target row and prove the state flip by fresh observation.
    const clickReceipt = await controller.act(
      { kind: 'click', ref: targets.targetRow.ref },
      { scopeId },
    )
    await new Promise(resolvePromise => setTimeout(resolvePromise, 300))
    const after = await controller.observe(
      { app: { bundleId }, maxDepth: 8, maxNodes: 300, ttlMs: 15_000 },
      { scopeId },
    )
    const statusAfter = after.targets.find(target => target.identifier === statusIdentifier)
    const statusValue = statusAfter?.value
    console.log(`[scroll-integration] click receipt status=${clickReceipt.status}; status label after click=${JSON.stringify(statusValue)}`)
    if (statusValue !== 'Status: clicked') {
      failLoud(`status label did not flip to 'Status: clicked' (got ${JSON.stringify(statusValue)})`)
    }

    console.log(JSON.stringify({
      ok: true,
      helperVersion: evidence.status.helperVersion,
      initial: {
        status: targets.status.value,
        scrollAreaFrame: targets.scrollArea.frame,
        targetRowBelowViewport: true,
      },
      scrolls: scrolls + 1,
      scrollReceiptStatuses: [...new Set(receipts.map(receipt => receipt.status))],
      clickReceiptStatus: clickReceipt.status,
      finalStatus: statusValue,
    }, null, 2))
  } finally {
    await controller.dispose()
    try { spawnSync('/usr/bin/pkill', ['-f', 'Fixture.app/Contents/MacOS/Fixture']) } catch { /* already gone */ }
    try { await rm(join(root, '.tmp', 'helper-cache'), { recursive: true, force: true }) } catch { /* cleanup best-effort */ }
  }
}

main().catch(error => {
  console.error('[scroll-integration] FAILED:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
