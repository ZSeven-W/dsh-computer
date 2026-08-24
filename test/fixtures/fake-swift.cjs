#!/usr/bin/env node
const { chmod, mkdir, readFile, writeFile } = require('node:fs/promises')
const { join } = require('node:path')

const marker = process.env.DSH_COMPUTER_FAKE_SWIFT_MARKER
const mode = process.env.DSH_COMPUTER_FAKE_SWIFT_MODE
if (!marker) process.exit(2)

async function invocationNumber() {
  const countPath = `${marker}.count`
  let prior = 0
  try { prior = Number.parseInt(await readFile(countPath, 'utf8'), 10) || 0 } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const next = prior + 1
  await writeFile(countPath, `${next}\n`)
  return next
}

async function successfulBuild() {
  const bin = `${marker}.success-bin`
  if (process.argv.includes('--show-bin-path')) {
    process.stdout.write(`${bin}\n`)
    return
  }
  await mkdir(bin, { recursive: true })
  const helper = join(bin, 'dsh-computer-helper')
  await writeFile(helper, `#!/usr/bin/env node
const chunks = []
process.stdin.on('data', chunk => chunks.push(chunk))
process.stdin.on('end', () => {
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  const result = {
    platform: 'macos', accessibilityTrusted: false, screenRecordingTrusted: false,
    sessionLocked: false, interactiveSessionAvailable: true,
    helperVersion: '0.1.0-rc.1', helperExecutable: process.argv[1],
    bundle: { path: null, identifier: null, version: null },
    signing: { signed: false, kind: 'unsigned', codeIdentifier: null, teamIdentifier: null, authorities: [], cdhash: null, statusCode: 0, detail: 'fake build' },
    process: { pid: process.pid, ppid: process.ppid },
    caller: { pid: process.ppid, executable: null, bundleIdentifier: null, name: null },
    resolution: { source: 'cache-build', selectedPath: process.argv[1] }, identityStable: false,
  }
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + '\\n')
})
`)
  await chmod(helper, 0o755)
  await writeFile(`${marker}.second-started`, 'started\n')
}

async function main() {
  const invocation = await invocationNumber()
  if (mode === 'hang-once-then-succeed' && invocation > 1) {
    await successfulBuild()
    return
  }
  let terminating = false
  process.on('SIGTERM', async () => {
    if (terminating) return
    terminating = true
    if (mode === 'hang-once-then-succeed') {
      await writeFile(`${marker}.terminating`, 'terminating\n')
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    await writeFile(`${marker}.terminated`, 'terminated\n')
    process.exit(143)
  })
  // Publishing the marker is the test's readiness handshake. Install the
  // signal handler first so observing "started" also proves cancellation can
  // be acknowledged; otherwise an immediate abort can land in the gap.
  await writeFile(marker, 'started\n')
  setInterval(() => {}, 1_000)
}

main().catch(error => {
  process.stderr.write(String(error))
  process.exit(1)
})
