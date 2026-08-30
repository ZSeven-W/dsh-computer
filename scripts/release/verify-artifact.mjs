#!/usr/bin/env node

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { runSync } from './release-utils.mjs'

function usage() {
  return [
    'Usage: node scripts/release/verify-artifact.mjs <path-to-app-or-binary> [--json]',
    '',
    'Reports signing truthfully: identity, Hardened Runtime, entitlements,',
    'Gatekeeper assessment, and notarization ticket presence/absence.',
    'Exit status is 0 when the report could be produced, even for ad-hoc or',
    'unsigned artifacts. Release readiness is reported as a boolean field.',
  ].join('\n')
}

function parseArgs(argv) {
  let json = false
  const paths = []
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${usage()}\n`)
      process.exit(0)
    }
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`)
    paths.push(arg)
  }
  if (paths.length !== 1) throw new Error(usage())
  return { path: resolve(paths[0]), json }
}

function parseDetails(details) {
  const identifier = /^Identifier=(.+)$/mu.exec(details)?.[1]?.trim() ?? null
  const teamIdentifierMatch = /^TeamIdentifier=(.+)$/mu.exec(details)?.[1]?.trim() ?? null
  const teamIdentifier = !teamIdentifierMatch || teamIdentifierMatch === 'not set' ? null : teamIdentifierMatch
  const authorities = [...details.matchAll(/^Authority=(.+)$/gmu)].map(match => match[1].trim())
  const cdhash = /^CandidateCDHash (?:sha256=)?([0-9a-f]+)$/imu.exec(details)?.[1]?.toLowerCase()
    ?? /^CDHash=([0-9a-f]+)$/imu.exec(details)?.[1]?.toLowerCase()
    ?? null
  const flagsLine = details.match(/^Flags=.*$/mu)?.[0] ?? ''
  const hardenedRuntime = /runtime/iu.test(flagsLine)
  return { identifier, teamIdentifier, authorities, cdhash, hardenedRuntime }
}

function classifySigning(signed, details, teamIdentifier) {
  if (!signed) return 'unsigned'
  if (/Signature=adhoc/iu.test(details) || teamIdentifier === null) return 'adhoc'
  const leaf = (details.match(/^Authority=(.+)$/mu)?.[1] ?? '').toLowerCase()
  if (leaf.includes('developer id application')) return 'developer-id'
  if (leaf.includes('apple development')) return 'development'
  if (leaf.includes('apple distribution') || leaf.includes('mac app distribution')) return 'distribution'
  return 'other'
}

export async function inspectArtifact(path) {
  const signedResult = runSync('/usr/bin/codesign', ['-d', '--verbose=4', path])
  const signed = signedResult.ok
  const details = `${signedResult.stdout}\n${signedResult.stderr}`
  const parsed = parseDetails(details)
  const kind = classifySigning(signed, details, parsed.teamIdentifier)

  const verifyResult = runSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', path])
  const entitlementsResult = runSync('/usr/bin/codesign', ['-d', '--entitlements', ':-', path])
  const entitlementsOutput = `${entitlementsResult.stdout}\n${entitlementsResult.stderr}`
  const entitlementsPresent = entitlementsResult.ok && /<\?xml|<\s*dict\s*>/iu.test(entitlementsOutput)
  const spctlResult = runSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', path])
  const staplerResult = runSync('/usr/bin/xcrun', ['stapler', 'validate', path])

  const notarizationTicketPresent = staplerResult.ok
  const releaseReady = signed
    && kind === 'developer-id'
    && parsed.hardenedRuntime
    && entitlementsPresent
    && verifyResult.ok
    && spctlResult.ok
    && staplerResult.ok

  return {
    path,
    signed,
    kind,
    codeIdentifier: parsed.identifier,
    teamIdentifier: parsed.teamIdentifier,
    authorities: parsed.authorities,
    cdhash: parsed.cdhash,
    hardenedRuntime: parsed.hardenedRuntime,
    entitlementsPresent,
    verification: {
      deepStrict: { ok: verifyResult.ok, output: `${verifyResult.stdout}${verifyResult.stderr}`.trim() },
      spctl: { ok: spctlResult.ok, output: `${spctlResult.stdout}${spctlResult.stderr}`.trim() },
      stapler: { ok: staplerResult.ok, output: `${staplerResult.stdout}${staplerResult.stderr}`.trim() },
    },
    notarizationTicketPresent,
    releaseReady,
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const { path, json } = parseArgs(process.argv.slice(2))
  const report = await inspectArtifact(path)
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    process.stdout.write([
      `Path: ${report.path}`,
      `Signed: ${report.signed}`,
      `Signature kind: ${report.kind}`,
      `Code identifier: ${report.codeIdentifier ?? 'none'}`,
      `Team identifier: ${report.teamIdentifier ?? 'none'}`,
      `Authorities: ${report.authorities.length === 0 ? 'none' : report.authorities.join(', ')}`,
      `CDHash: ${report.cdhash ?? 'none'}`,
      `Hardened Runtime: ${report.hardenedRuntime}`,
      `Entitlements present: ${report.entitlementsPresent}`,
      `Deep strict verify: ${report.verification.deepStrict.ok ? 'passed' : 'FAILED'}`,
      `spctl assessment: ${report.verification.spctl.ok ? 'passed' : 'FAILED'}`,
      `Notarization ticket: ${report.notarizationTicketPresent ? 'present' : 'absent'}`,
      `Release ready: ${report.releaseReady}`,
    ].join('\n') + '\n')
    process.exitCode = 0
  }
}
