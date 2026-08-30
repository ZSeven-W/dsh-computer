#!/usr/bin/env node

import { spawn } from 'node:child_process'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUNDLE_ID = 'io.github.zseven-w.dsh-computer.helper'
const EXECUTABLE = 'dsh-computer-helper'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const nativeRoot = join(root, 'native')
const tmpRoot = join(root, '.tmp')
const clangModuleCache = join(tmpRoot, 'clang-module-cache')
const swiftpmCache = join(root, '.swiftpm', 'cache')
const swiftpmConfig = join(root, '.swiftpm', 'config')
const swiftpmSecurity = join(root, '.swiftpm', 'security')
const installParent = join(homedir(), 'Library', 'Application Support', 'ZSeven', 'DSH Computer')
const destination = join(installParent, 'DSH Computer Helper.app')

function usage() {
  return [
    'Usage: pnpm run helper:install-local -- --identity <codesign identity>',
    '',
    'This explicit command builds, signs, verifies, and installs the local Helper at:',
    `  ${destination}`,
    '',
    'It never chooses an identity, opens System Settings, or requests a TCC permission.',
  ].join('\n')
}

function signingIdentity(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`)
    process.exit(0)
  }
  if (argv.length !== 2 || argv[0] !== '--identity' || argv[1]?.trim() === '') {
    throw new Error(usage())
  }
  const identity = argv[1].trim()
  if (identity === '-') throw new Error('ad-hoc signing identity "-" is not stable and is refused')
  return identity
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${stdout}${stderr}`)))
  })
}

function xml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

async function existingPath(path) {
  try { return await lstat(path) } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

const identity = signingIdentity(process.argv.slice(2))
if (process.platform !== 'darwin') throw new Error('the local DSH Computer Helper can only be assembled on macOS')

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const shortVersion = String(manifest.version).split('-')[0]
await Promise.all([
  mkdir(tmpRoot, { recursive: true }),
  mkdir(swiftpmCache, { recursive: true }),
  mkdir(swiftpmConfig, { recursive: true }),
  mkdir(swiftpmSecurity, { recursive: true }),
])
const swiftEnv = {
  ...process.env,
  TMPDIR: tmpRoot,
  CLANG_MODULE_CACHE_PATH: clangModuleCache,
}
const swiftCommon = [
  '--package-path', nativeRoot,
  '--scratch-path', join(nativeRoot, '.build'),
  '--cache-path', swiftpmCache,
  '--config-path', swiftpmConfig,
  '--security-path', swiftpmSecurity,
  '--manifest-cache', 'local',
  '--disable-sandbox',
]
await run('swift', ['build', '-c', 'release', ...swiftCommon], { env: swiftEnv })
const shown = await run('swift', [
  'build', '-c', 'release', ...swiftCommon, '--show-bin-path',
], { env: swiftEnv })
const builtExecutable = join(shown.stdout.trim(), EXECUTABLE)

await mkdir(installParent, { recursive: true, mode: 0o700 })
const stagingRoot = await mkdtemp(join(installParent, '.helper-stage-'))
const stagedApp = join(stagingRoot, 'DSH Computer Helper.app')
const contents = join(stagedApp, 'Contents')
const macOS = join(contents, 'MacOS')
const stagedExecutable = join(macOS, EXECUTABLE)
const backup = join(installParent, `.DSH Computer Helper.backup-${process.pid}.app`)
let destinationMoved = false
let stagedInstalled = false

try {
  await mkdir(macOS, { recursive: true, mode: 0o755 })
  await Promise.all([chmod(stagedApp, 0o755), chmod(contents, 0o755), chmod(macOS, 0o755)])
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>DSH Computer Helper</string>
  <key>CFBundleExecutable</key><string>${EXECUTABLE}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>DSH Computer Helper</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${xml(shortVersion)}</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSBackgroundOnly</key><true/>
</dict>
</plist>
`
  await writeFile(join(contents, 'Info.plist'), plist, { mode: 0o644 })
  await copyFile(builtExecutable, stagedExecutable)
  await chmod(stagedExecutable, 0o755)

  await run('/usr/bin/codesign', [
    '--force', '--options', 'runtime', '--timestamp=none', '--sign', identity, stagedApp,
  ])
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', stagedApp])
  const described = await run('/usr/bin/codesign', ['-d', '--verbose=4', stagedApp])
  const details = `${described.stdout}\n${described.stderr}`
  const identifier = /^Identifier=(.+)$/mu.exec(details)?.[1]?.trim()
  const teamIdentifier = /^TeamIdentifier=(.+)$/mu.exec(details)?.[1]?.trim()
  if (identifier !== BUNDLE_ID) throw new Error(`codesign produced identifier ${identifier ?? 'missing'}, expected ${BUNDLE_ID}`)
  if (teamIdentifier === undefined || teamIdentifier === '' || teamIdentifier === 'not set' || /^Signature=adhoc$/mu.test(details)) {
    throw new Error('codesign produced an ad-hoc or teamless signature; a certificate-backed identity is required')
  }

  const previous = await existingPath(destination)
  if (previous?.isSymbolicLink()) throw new Error(`refusing to replace symbolic-link destination: ${destination}`)
  if (await existingPath(backup)) throw new Error(`refusing to overwrite stale backup: ${backup}`)
  if (previous !== undefined) {
    await rename(destination, backup)
    destinationMoved = true
  }
  try {
    await rename(stagedApp, destination)
    stagedInstalled = true
  } catch (error) {
    if (destinationMoved) {
      await rename(backup, destination)
      destinationMoved = false
    }
    throw error
  }
  if (destinationMoved) await rm(backup, { recursive: true })

  process.stdout.write([
    'Local DSH Computer Helper installed and signature-verified.',
    `Path: ${destination}`,
    `Bundle ID: ${BUNDLE_ID}`,
    `Team ID: ${teamIdentifier}`,
    'No Accessibility or Screen Recording permission was requested.',
    'Grant permissions to this exact Helper in System Settings only when you are ready to test it.',
  ].join('\n') + '\n')
} finally {
  if (!stagedInstalled && destinationMoved && !await existingPath(destination) && await existingPath(backup)) {
    await rename(backup, destination)
  }
  await rm(stagingRoot, { recursive: true, force: true })
}
