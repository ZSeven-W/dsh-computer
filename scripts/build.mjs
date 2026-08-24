import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false })
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
  await run('swift', ['build', '-c', 'release', '--package-path', 'native'])
} else {
  console.log(`Swift helper build skipped on ${process.platform}; runtime reports macOS-only support`)
}
