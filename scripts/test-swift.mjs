import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  console.log(`Swift helper tests skipped on ${process.platform}; runtime reports macOS-only support`)
  process.exit(0)
}

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tmpRoot = join(root, '.tmp')
const clangModuleCache = join(tmpRoot, 'clang-module-cache')
const swiftpmCache = join(root, '.swiftpm', 'cache')
const swiftpmConfig = join(root, '.swiftpm', 'config')
const swiftpmSecurity = join(root, '.swiftpm', 'security')

mkdirSync(tmpRoot, { recursive: true })
mkdirSync(swiftpmCache, { recursive: true })
mkdirSync(swiftpmConfig, { recursive: true })
mkdirSync(swiftpmSecurity, { recursive: true })

const child = spawn('swift', [
  'test',
  '--package-path', 'native',
  '--scratch-path', join(root, 'native', '.build'),
  '--cache-path', swiftpmCache,
  '--config-path', swiftpmConfig,
  '--security-path', swiftpmSecurity,
  '--manifest-cache', 'local',
  '--disable-sandbox',
  // This package's suite is XCTest only (7 files import XCTest, none import
  // Testing), so running the second harness Swift 6 starts by default buys
  // nothing. Keep it off to save a runner process.
  //
  // NOTE: this flag was first added on the theory that the empty swift-testing
  // runner caused `error: Exited with unexpected signal code 5` on GitHub's
  // macOS images. That theory is WRONG — the crash reproduces with the flag in
  // place. What is actually known: ComputerCoreTests (23 tests) passes, then
  // the XCTest binary dies entering ObservationWalkTests, ~0.6s after `Build
  // complete`, only on hosted runners; all 67 pass locally on a machine with a
  // real GUI session. Do not treat this flag as the fix for that.
  '--disable-swift-testing',
], {
  stdio: 'inherit',
  shell: false,
  env: {
    ...process.env,
    TMPDIR: tmpRoot,
    CLANG_MODULE_CACHE_PATH: clangModuleCache,
  },
})
child.on('error', error => { throw error })
child.on('close', async code => {
  process.exitCode = code ?? 1
  if (code === 0) return
  // A Swift test binary that dies on a signal (SIGTRAP shows up as "Exited with
  // unexpected signal code 5") prints no reason at all through SwiftPM. The
  // macOS crash report has the thread backtrace and the termination reason, and
  // on a CI runner it is the only way to learn what happened — nobody can
  // attach a debugger there. Surface it instead of leaving the next reader with
  // a bare signal number.
  const { readdir, readFile, stat } = await import('node:fs/promises')
  const { homedir } = await import('node:os')
  const dirs = [
    join(homedir(), 'Library', 'Logs', 'DiagnosticReports'),
    '/Library/Logs/DiagnosticReports',
  ]
  const since = Date.now() - 10 * 60 * 1000
  for (const dir of dirs) {
    let names = []
    try { names = await readdir(dir) } catch { continue }
    for (const name of names) {
      if (!/DSHComputerHelper|xctest|swift-testing/i.test(name)) continue
      const path = join(dir, name)
      try {
        const info = await stat(path)
        if (info.mtimeMs < since) continue
        const text = await readFile(path, 'utf8')
        console.error('\n===== crash report: ' + path + ' =====')
        console.error(text.split('\n').slice(0, 80).join('\n'))
      } catch { /* unreadable report is not worth failing over */ }
    }
  }
})
