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
