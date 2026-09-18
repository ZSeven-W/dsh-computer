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
child.on('close', code => { process.exitCode = code ?? 1 })
