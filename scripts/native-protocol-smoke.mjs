import { access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

if (process.platform !== 'darwin') {
  console.log(`native protocol smoke skipped on ${process.platform}`)
  process.exit(0)
}

const candidates = [
  join('native', '.build', 'release', 'dsh-computer-helper'),
  join('native', '.build', 'debug', 'dsh-computer-helper'),
]
let binary
for (const candidate of candidates) {
  try { await access(candidate); binary = candidate; break } catch { /* try next build configuration */ }
}
if (!binary) throw new Error('native helper binary not found; run swift build or swift test first')

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

const observe = await request({
  id: 'observe-smoke', command: 'observe', app: null, window: null, maxDepth: 1, maxNodes: 4,
})
if (!observe.ok && observe.error?.code !== 'accessibility_permission_required') {
  throw new Error(`unexpected bounded observation response: ${JSON.stringify(observe)}`)
}
console.log(JSON.stringify({
  nativeStatus: status.result,
  boundedObserve: observe.ok
    ? { ok: true, nodes: observe.result.nodes.length, truncated: observe.result.truncated }
    : { ok: false, code: observe.error.code },
}))
