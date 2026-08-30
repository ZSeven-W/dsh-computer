#!/usr/bin/env node

import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import {
  BUNDLE_ID,
  CASK_TEMPLATE_PATH,
  ENTITLEMENTS_PATH,
  EXECUTABLE_NAME,
  loadReleaseConfig,
  logDryRun,
  logStep,
  notaryCredentials,
  pathExists,
  root,
  runOrThrow,
  runSync,
  sha256File,
  signingIdentity,
  teamIdentifier,
  writeChecksums,
} from './release-utils.mjs'
import { inspectArtifact } from './verify-artifact.mjs'

const APP_NAME = 'DSH Computer Helper.app'
const tmpRoot = join(root, '.tmp')
const clangModuleCache = join(tmpRoot, 'clang-module-cache')
const swiftpmCache = join(root, '.swiftpm', 'cache')
const swiftpmConfig = join(root, '.swiftpm', 'config')
const swiftpmSecurity = join(root, '.swiftpm', 'security')

function usage() {
  return [
    'Usage: node scripts/release/release.mjs [options]',
    '',
    'Options:',
    '  --dry-run                Print every release step and stop at the first',
    '                           step requiring a certificate/API key.',
    '  --config <path>          Path to a KEY=VALUE release config file.',
    '                           Default: scripts/release/release-config.env',
    '  --output-dir <path>      Artifact output directory.',
    '                           Default: dist/release',
    '  --binary <path>          Use an existing built helper executable instead',
    '                           of running swift build.',
    '  --help                   Show this help.',
  ].join('\n')
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    config: undefined,
    outputDir: resolve('dist', 'release'),
    binary: undefined,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${usage()}\n`)
      process.exit(0)
    }
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (arg === '--config') {
      const value = argv[index + 1]
      if (!value) throw new Error('--config requires a path')
      options.config = resolve(value)
      index += 1
      continue
    }
    if (arg === '--output-dir') {
      const value = argv[index + 1]
      if (!value) throw new Error('--output-dir requires a path')
      options.outputDir = resolve(value)
      index += 1
      continue
    }
    if (arg === '--binary') {
      const value = argv[index + 1]
      if (!value) throw new Error('--binary requires a path')
      options.binary = resolve(value)
      index += 1
      continue
    }
    if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`)
    throw new Error(`unexpected argument: ${arg}`)
  }
  return options
}

async function assertExecutable(path) {
  if (!await pathExists(path)) throw new Error(`binary does not exist: ${path}`)
  const result = runSync('/bin/test', ['-x', path])
  if (!result.ok) throw new Error(`binary is not executable: ${path}`)
}

async function resolveBinary(options) {
  if (options.binary) {
    await assertExecutable(options.binary)
    logStep(`Using prebuilt helper: ${options.binary}`)
    return options.binary
  }
  logStep('Building native helper (swift build -c release)')
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
    '--package-path', 'native',
    '--scratch-path', join(root, 'native', '.build'),
    '--cache-path', swiftpmCache,
    '--config-path', swiftpmConfig,
    '--security-path', swiftpmSecurity,
    '--manifest-cache', 'local',
    '--disable-sandbox',
  ]
  runOrThrow('swift', ['build', '-c', 'release', ...swiftCommon], { env: swiftEnv })
  const shown = runOrThrow('swift', [
    'build', '-c', 'release', ...swiftCommon, '--show-bin-path',
  ], { env: swiftEnv })
  return join(shown.stdout.trim(), EXECUTABLE_NAME)
}

function infoPlist(shortVersion) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>DSH Computer Helper</string>
  <key>CFBundleExecutable</key><string>${EXECUTABLE_NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>DSH Computer Helper</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${shortVersion}</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSBackgroundOnly</key><true/>
</dict>
</plist>
`
}

async function assembleApp(binary, outputDir, shortVersion) {
  logStep('Assembling DSH Computer Helper.app')
  const appDir = join(outputDir, 'staging', APP_NAME)
  const contentsDir = join(appDir, 'Contents')
  const macOSDir = join(contentsDir, 'MacOS')
  await rm(join(outputDir, 'staging'), { recursive: true, force: true })
  await mkdir(macOSDir, { recursive: true, mode: 0o755 })
  await Promise.all([
    chmod(appDir, 0o755),
    chmod(contentsDir, 0o755),
    chmod(macOSDir, 0o755),
  ])
  await writeFile(join(contentsDir, 'Info.plist'), infoPlist(shortVersion), { mode: 0o644 })
  const executable = join(macOSDir, EXECUTABLE_NAME)
  await copyFile(binary, executable)
  await chmod(executable, 0o755)
  return appDir
}

function codesignCommand(identity, appDir) {
  return [
    '/usr/bin/codesign', '--force', '--options', 'runtime', '--timestamp',
    '--sign', identity, '--entitlements', ENTITLEMENTS_PATH, appDir,
  ]
}

function notarytoolCommand(zipPath, credentials) {
  return [
    '/usr/bin/xcrun', 'notarytool', 'submit', zipPath,
    '--key-id', credentials.keyId,
    '--issuer', credentials.issuer,
    '--key', credentials.keyPath,
    '--wait', '--output-format', 'json',
  ]
}

function printDryRunPlan({ appDir, zipPath, dmgPath, version, identity, credentials }) {
  const identityLabel = identity ?? '$DSH_COMPUTER_SIGNING_IDENTITY'
  logDryRun(`codesign --force --options runtime --timestamp --sign ${identityLabel} --entitlements ${ENTITLEMENTS_PATH} ${appDir}`)
  logDryRun(`ditto -c -k --keepParent ${appDir} ${zipPath}`)
  if (credentials.keyId && credentials.issuer && credentials.keyPath) {
    logDryRun(`xcrun notarytool submit ${zipPath} --key-id ${credentials.keyId} --issuer ${credentials.issuer} --key ${credentials.keyPath} --wait`)
  } else {
    logDryRun('xcrun notarytool submit <zip> --key-id $DSH_COMPUTER_NOTARY_KEY_ID --issuer $DSH_COMPUTER_NOTARY_ISSUER_ID --key $DSH_COMPUTER_NOTARY_KEY_PATH --wait')
  }
  logDryRun(`xcrun stapler staple ${appDir}`)
  logDryRun(`codesign --verify --deep --strict --verbose=2 ${appDir}`)
  logDryRun(`/usr/sbin/spctl --assess --type execute --verbose=4 ${appDir}`)
  logDryRun(`xcrun stapler validate ${appDir}`)
  logDryRun(`hdiutil create -volname "DSH Computer Helper" -srcfolder ${appDir} -ov -format UDZO ${dmgPath}`)
  logDryRun(`write SHA256SUMS for ${dmgPath}, ${zipPath}`)
  logDryRun(`generate ${join(dirname(dmgPath), 'dsh-computer.rb')} from ${CASK_TEMPLATE_PATH} with version ${version}, DMG filename ${basename(dmgPath)}, sha256 __SHA256__`)
}

function verifyTeam(appDir, expectedTeam) {
  const described = runOrThrow('/usr/bin/codesign', ['-d', '--verbose=4', appDir])
  const details = `${described.stdout}\n${described.stderr}`
  const identifier = /^Identifier=(.+)$/mu.exec(details)?.[1]?.trim()
  const teamIdentifierValue = /^TeamIdentifier=(.+)$/mu.exec(details)?.[1]?.trim()
  const isAdHoc = /^Signature=adhoc$/mu.test(details) || teamIdentifierValue === 'not set'
  if (identifier !== BUNDLE_ID) {
    throw new Error(`signed identifier is ${identifier ?? 'missing'}, expected ${BUNDLE_ID}`)
  }
  if (isAdHoc || !teamIdentifierValue || teamIdentifierValue === 'not set') {
    throw new Error('codesign produced an ad-hoc or teamless signature; Developer ID signing failed')
  }
  if (expectedTeam && teamIdentifierValue !== expectedTeam) {
    throw new Error(`TeamIdentifier ${teamIdentifierValue} does not match configured DSH_COMPUTER_TEAM_ID ${expectedTeam}`)
  }
  return teamIdentifierValue
}

async function buildDmg(appDir, dmgPath) {
  logStep('Building DMG with hdiutil')
  await rm(dmgPath, { force: true })
  runOrThrow('/usr/bin/hdiutil', [
    'create', '-volname', 'DSH Computer Helper',
    '-srcfolder', appDir, '-ov', '-format', 'UDZO', dmgPath,
  ])
}

async function writeCask({ outputDir, dmgPath, version }) {
  logStep('Generating Homebrew cask from template')
  const template = await readFile(CASK_TEMPLATE_PATH, 'utf8')
  const dmgSha256 = await sha256File(dmgPath)
  const rendered = template
    .replaceAll('__VERSION__', version)
    .replaceAll('__DMG_FILENAME__', basename(dmgPath))
    .replaceAll('__SHA256__', dmgSha256)
  const caskPath = join(outputDir, 'dsh-computer.rb')
  await writeFile(caskPath, rendered, 'utf8')
  return { caskPath, dmgSha256 }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (process.platform !== 'darwin') {
    throw new Error('DSH Computer release artifacts can only be built on macOS')
  }
  const config = await loadReleaseConfig({ configPath: options.config, env: process.env })
  const identity = signingIdentity(config)
  const team = teamIdentifier(config)
  const credentials = notaryCredentials(config)
  const manifest = JSON.parse(await readFile(resolve('package.json'), 'utf8'))
  const version = String(manifest.version)
  const shortVersion = version.split('-')[0]

  await mkdir(options.outputDir, { recursive: true })

  const binary = await resolveBinary(options)
  const appDir = await assembleApp(binary, options.outputDir, shortVersion)
  const zipPath = join(options.outputDir, `DSH Computer Helper-${version}-notarization.zip`)
  const dmgPath = join(options.outputDir, `DSH Computer Helper-${version}.dmg`)

  logStep('Codesigning with Developer ID + Hardened Runtime + entitlements')
  if (!identity) {
    process.stdout.write('\n[release] Missing Developer ID signing identity.\n')
    printDryRunPlan({ appDir, zipPath, dmgPath, version, identity: undefined, credentials })
    throw new Error(
      'missing signing identity: set DSH_COMPUTER_SIGNING_IDENTITY '
      + '(or copy scripts/release/release-config.example.env to scripts/release/release-config.env '
      + 'and fill it in); see RELEASE.md',
    )
  }

  if (options.dryRun) {
    printDryRunPlan({ appDir, zipPath, dmgPath, version, identity, credentials })
    process.stdout.write('\n[dry-run] No certificate-requiring step was executed.\n')
    return
  }

  const signArgs = codesignCommand(identity, appDir)
  runOrThrow(signArgs[0], signArgs.slice(1))
  const actualTeam = verifyTeam(appDir, team)
  process.stdout.write(`[release] Signed ${appDir} with TeamIdentifier ${actualTeam}\n`)

  logStep('Creating notarization archive (ditto zip)')
  await rm(zipPath, { force: true })
  runOrThrow('/usr/bin/ditto', ['-c', '-k', '--keepParent', appDir, zipPath])

  logStep('Notarizing with notarytool (submit + wait)')
  const missingNotary = ['keyId', 'issuer', 'keyPath'].filter(key => !credentials[key])
  if (missingNotary.length > 0) {
    process.stdout.write('\n[release] Missing App Store Connect API key configuration.\n')
    printDryRunPlan({ appDir, zipPath, dmgPath, version, identity, credentials })
    throw new Error(
      'missing notary credentials: set DSH_COMPUTER_NOTARY_KEY_ID, '
      + 'DSH_COMPUTER_NOTARY_ISSUER_ID, and DSH_COMPUTER_NOTARY_KEY_PATH '
      + '(or populate scripts/release/release-config.env); see RELEASE.md',
    )
  }
  if (!await pathExists(credentials.keyPath)) {
    throw new Error(`notary API key file does not exist: ${credentials.keyPath}`)
  }
  const notaryArgs = notarytoolCommand(zipPath, credentials)
  runOrThrow(notaryArgs[0], notaryArgs.slice(1))

  logStep('Stapling notarization ticket to the app')
  runOrThrow('/usr/bin/xcrun', ['stapler', 'staple', appDir])

  logStep('Verifying signed, notarized artifact')
  const report = await inspectArtifact(appDir)
  const verifyCommands = [
    ['/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appDir]],
    ['/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', appDir]],
    ['/usr/bin/xcrun', ['stapler', 'validate', appDir]],
  ]
  for (const [command, args] of verifyCommands) {
    const result = runSync(command, args)
    if (!result.ok) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}${result.stderr}`)
  }
  if (!report.releaseReady) {
    throw new Error(`artifact did not pass release verification: ${JSON.stringify(report, null, 2)}`)
  }
  process.stdout.write(`[release] Verification passed for ${appDir}\n`)

  await buildDmg(appDir, dmgPath)

  logStep('Writing SHA256 checksums')
  const checksumFiles = [dmgPath, zipPath]
  const checksumsPath = join(options.outputDir, 'SHA256SUMS')
  const checksumText = await writeChecksums(checksumFiles, checksumsPath)
  process.stdout.write(checksumText)

  const { caskPath, dmgSha256 } = await writeCask({ outputDir: options.outputDir, dmgPath, version })
  process.stdout.write(`[release] Wrote ${caskPath} with sha256 ${dmgSha256}\n`)

  process.stdout.write('\n[release] Pipeline complete. Artifacts are in '
    + `${options.outputDir} (DMG, app, notarization zip, SHA256SUMS, dsh-computer.rb).\n`)
}

main().catch(error => {
  process.stderr.write(`\nerror: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
