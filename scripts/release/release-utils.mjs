import { createHash } from 'node:crypto'
import { access, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

export const BUNDLE_ID = 'io.github.zseven-w.dsh-computer.helper'
export const EXECUTABLE_NAME = 'dsh-computer-helper'
export const APP_NAME = 'DSH Computer Helper.app'
export const STABLE_HELPER_APP_NAME = APP_NAME
export const DEFAULT_RELEASE_CONFIG = join(root, 'scripts', 'release', 'release-config.env')
export const ENTITLEMENTS_PATH = join(root, 'scripts', 'release', 'DSHComputerHelper.entitlements')
export const CASK_TEMPLATE_PATH = join(root, 'scripts', 'release', 'dsh-computer.rb.template')

export function readManifest() {
  const text = readFileSync(join(root, 'package.json'), 'utf8')
  return JSON.parse(text)
}

export function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: 'utf8',
    shell: false,
    timeout: options.timeoutMs,
  })
  if (result.error) throw result.error
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

export function runOrThrow(command, args, options = {}) {
  const result = runSync(command, args, options)
  if (!result.ok) {
    const message = `${command} ${args.join(' ')} exited ${result.status ?? 'unknown'}`
    throw new Error(`${message}\n${result.stdout}${result.stderr}`.trim())
  }
  return result
}

export function parseEnvFile(text) {
  const values = {}
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line)
    if (!match) continue
    const [, key, rawValue] = match
    let value = rawValue.trim()
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    values[key] = value
  }
  return values
}

export async function loadReleaseConfig({ configPath = DEFAULT_RELEASE_CONFIG, env = process.env } = {}) {
  const config = {}
  try {
    const text = await readFile(configPath, 'utf8')
    Object.assign(config, parseEnvFile(text))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  // Environment variables take precedence over the local config file.
  const merged = { ...config }
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('DSH_COMPUTER_')) merged[key] = value
  }
  return merged
}

export function signingIdentity(config) {
  const identity = (config.DSH_COMPUTER_SIGNING_IDENTITY ?? '').trim()
  return identity === '' ? undefined : identity
}

export function teamIdentifier(config) {
  const teamId = (config.DSH_COMPUTER_TEAM_ID ?? '').trim()
  return teamId === '' ? undefined : teamId
}

export function notaryCredentials(config) {
  const keyId = (config.DSH_COMPUTER_NOTARY_KEY_ID ?? '').trim()
  const issuer = (config.DSH_COMPUTER_NOTARY_ISSUER_ID ?? '').trim()
  const keyPath = (config.DSH_COMPUTER_NOTARY_KEY_PATH ?? '').trim()
  return { keyId, issuer, keyPath }
}

export async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

export async function sha256File(filePath) {
  const hash = createHash('sha256')
  hash.update(await readFile(filePath))
  return hash.digest('hex')
}

export async function writeChecksums(files, outputPath) {
  const lines = []
  for (const file of files) {
    const hash = await sha256File(file)
    const display = resolve(file)
    lines.push(`${hash}  ${display}`)
  }
  const text = `${lines.join('\n')}\n`
  await writeFile(outputPath, text, 'utf8')
  return text
}

export function quoteArg(value) {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/u.test(value)) return value
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

export function formatCommand(args) {
  return args.map(quoteArg).join(' ')
}

export function logStep(message) {
  process.stdout.write(`\n[release] ${message}\n`)
}

export function logDryRun(message) {
  process.stdout.write(`[dry-run] WOULD ${message}\n`)
}
