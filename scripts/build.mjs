import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const tmpRoot = join(root, '.tmp')
const clangModuleCache = join(tmpRoot, 'clang-module-cache')
const swiftpmCache = join(root, '.swiftpm', 'cache')
const swiftpmConfig = join(root, '.swiftpm', 'config')
const swiftpmSecurity = join(root, '.swiftpm', 'security')

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: false,
      ...options,
    })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)))
  })
}

function versionLiteral(source, pattern, label) {
  const value = pattern.exec(source)?.[1]
  if (value === undefined) throw new Error(`could not read ${label} version literal`)
  return value
}

const [manifestText, transportSource, swiftSource] = await Promise.all([
  readFile('package.json', 'utf8'),
  readFile(join('src', 'native-helper.ts'), 'utf8'),
  readFile(join('native', 'Sources', 'DSHComputerHelper', 'main.swift'), 'utf8'),
])
const packageVersion = JSON.parse(manifestText).version
const transportVersion = versionLiteral(
  transportSource,
  /const HELPER_PROTOCOL_VERSION = '([^']+)'/u,
  'Node Helper protocol',
)
const swiftVersion = versionLiteral(
  swiftSource,
  /private let helperVersion = "([^"]+)"/u,
  'Swift Helper protocol',
)
if (typeof packageVersion !== 'string' || packageVersion !== transportVersion || packageVersion !== swiftVersion) {
  throw new Error(
    `version drift: package=${String(packageVersion)} Node=${transportVersion} Swift=${swiftVersion}`,
  )
}

await run(process.execPath, [join('node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'])
if (process.platform === 'darwin') {
  mkdirSync(tmpRoot, { recursive: true })
  mkdirSync(swiftpmCache, { recursive: true })
  mkdirSync(swiftpmConfig, { recursive: true })
  mkdirSync(swiftpmSecurity, { recursive: true })
  await run('swift', [
    'build', '-c', 'release',
    '--package-path', 'native',
    '--scratch-path', join(root, 'native', '.build'),
    '--cache-path', swiftpmCache,
    '--config-path', swiftpmConfig,
    '--security-path', swiftpmSecurity,
    '--manifest-cache', 'local',
    '--disable-sandbox',
  ], {
    env: {
      ...process.env,
      TMPDIR: tmpRoot,
      CLANG_MODULE_CACHE_PATH: clangModuleCache,
    },
  })
} else {
  console.log(`Swift helper build skipped on ${process.platform}; runtime reports macOS-only support`)
}
