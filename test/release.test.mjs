import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')

function runScript(script, args, options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) }
  if (options.clearDshEnv) {
    for (const key of Object.keys(env)) {
      if (key.startsWith('DSH_COMPUTER_')) delete env[key]
    }
  }
  return spawnSync(process.execPath, [join(root, script), ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    shell: false,
  })
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

test('release pipeline --help prints usage and exits 0', () => {
  const result = runScript('scripts/release/release.mjs', ['--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /Usage: node scripts\/release\/release\.mjs/u)
})

test('release pipeline rejects unknown options', () => {
  const result = runScript('scripts/release/release.mjs', ['--definitely-not-an-option'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /unknown option/u)
})

test('checksum script writes SHA256 lines and accepts --output', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-release-checksum-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const fileA = join(dir, 'a.bin')
  const fileB = join(dir, 'b.bin')
  await writeFile(fileA, 'alpha')
  await writeFile(fileB, 'beta\n')
  const output = join(dir, 'SHA256SUMS')
  const result = runScript('scripts/release/checksum.mjs', [fileA, fileB, '--output', output])
  assert.equal(result.status, 0, result.stderr)
  const text = await readFile(output, 'utf8')
  const lines = text.trim().split('\n')
  assert.equal(lines.length, 2)
  assert.ok(lines[0].startsWith(`${sha256('alpha')}  `))
  assert.ok(lines[1].startsWith(`${sha256('beta\n')}  `))
  assert.match(text, /a\.bin/u)
  assert.match(text, /b\.bin/u)
})

test('checksum script requires at least one file', () => {
  const result = runScript('scripts/release/checksum.mjs', [])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Usage: node scripts\/release\/checksum\.mjs/u)
})

test('verify script requires exactly one artifact path', () => {
  const result = runScript('scripts/release/verify-artifact.mjs', [])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Usage: node scripts\/release\/verify-artifact\.mjs/u)
})

test('dry-run pipeline without signing identity prints every step and fails only at signing', { skip: process.platform !== 'darwin' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-release-dry-run-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const result = runScript('scripts/release/release.mjs', [
    '--dry-run',
    '--output-dir', dir,
    '--binary', '/bin/echo',
  ], { clearDshEnv: true })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /missing signing identity/u)
  assert.match(result.stdout, /\[dry-run\] WOULD .*codesign --force --options runtime/u)
  assert.match(result.stdout, /\[dry-run\] WOULD .*notarytool submit/u)
  assert.match(result.stdout, /\[dry-run\] WOULD .*stapler staple/u)
  assert.match(result.stdout, /\[dry-run\] WOULD .*hdiutil create/u)
  assert.match(result.stdout, /\[dry-run\] WOULD .*SHA256SUMS/u)
  // The pipeline must not claim a signed/notarized artifact in dry-run mode.
  assert.doesNotMatch(result.stdout, /Pipeline complete/u)
})

test('verify script truthfully reports an ad-hoc artifact as ad-hoc and not release-ready', { skip: process.platform !== 'darwin' }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-release-verify-adhoc-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const binary = join(dir, 'ad-hoc-binary')
  const copy = spawnSync('/bin/cp', ['/bin/echo', binary], { encoding: 'utf8' })
  assert.equal(copy.status, 0, copy.stderr)
  const signed = spawnSync('/usr/bin/codesign', [
    '--force', '--identifier', 'io.github.zseven-w.dsh-computer.test-adhoc', '--sign', '-', binary,
  ], { encoding: 'utf8' })
  assert.equal(signed.status, 0, `${signed.stdout}${signed.stderr}`)
  const result = runScript('scripts/release/verify-artifact.mjs', [binary, '--json'])
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(result.stdout)
  assert.equal(report.signed, true)
  assert.equal(report.kind, 'adhoc')
  assert.equal(report.teamIdentifier, null)
  assert.equal(report.releaseReady, false)
  assert.equal(report.notarizationTicketPresent, false)
})
