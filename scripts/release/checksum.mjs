#!/usr/bin/env node

import { resolve } from 'node:path'
import { writeChecksums } from './release-utils.mjs'

function usage() {
  return [
    'Usage: node scripts/release/checksum.mjs <file> [<file> ...] [--output <path>]',
    '',
    'Writes SHA256 lines in the standard "hash  absolute-path" format.',
    'If --output is omitted, the checksum text is printed to stdout.',
  ].join('\n')
}

function parseArgs(argv) {
  const files = []
  let output
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${usage()}\n`)
      process.exit(0)
    }
    if (arg === '--output') {
      const value = argv[index + 1]
      if (!value) throw new Error('--output requires a path')
      output = value
      index += 1
      continue
    }
    if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`)
    files.push(arg)
  }
  if (files.length === 0) throw new Error(usage())
  return { files, output }
}

const { files, output } = parseArgs(process.argv.slice(2))
const text = await writeChecksums(files.map(file => resolve(file)), output)
if (output) {
  process.stdout.write(`Wrote ${output}\n`)
} else {
  process.stdout.write(text)
}
