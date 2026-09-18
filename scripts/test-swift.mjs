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
  // Testing). Under Swift 6 `swift test` runs BOTH harnesses, and the empty
  // swift-testing runner is what aborts on GitHub's macOS images:
  //   Test run with 0 tests in 0 suites passed
  //   error: Exited with unexpected signal code 5
  // while every XCTest suite had already passed. Running only the harness that
  // owns the tests removes the crash without skipping a single test; drop this
  // flag the moment a swift-testing test is added.
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
