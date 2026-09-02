import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { COMPUTER_OMITTED_REASON_VOCABULARY } from '../lib/index.js'

// Keeps the documented Set-of-Mark omission vocabulary in lockstep with the
// reasons the controller and the native helper actually emit: the README list
// must equal the exported vocabulary, every member must appear as a literal
// in the code, and no reason: site may emit an undocumented identifier.
test('README omission-reason vocabulary equals the reason identifiers in code', async () => {
  const root = new URL('..', import.meta.url)
  const [english, chinese, controller, swift] = await Promise.all([
    readFile(new URL('README.md', root), 'utf8'),
    readFile(new URL('README.zh.md', root), 'utf8'),
    readFile(new URL('src/controller.ts', root), 'utf8'),
    readFile(new URL('native/Sources/DSHComputerHelper/main.swift', root), 'utf8'),
  ])

  // Documented set: the backticked identifiers on the vocabulary line.
  const sentence = /reason vocabulary:\s*(.+)/u.exec(english)
  assert.ok(sentence, 'README.md must document the vocabulary on one marked line')
  const documented = [...sentence[1].matchAll(/`([a-z][a-z0-9_-]*)(?:: …)?`/gu)]
    .map(match => match[1].split(':')[0])
  assert.deepEqual(
    [...documented].sort(),
    [...COMPUTER_OMITTED_REASON_VOCABULARY].sort(),
    'README vocabulary must equal the exported reason vocabulary',
  )

  // Emitted set: single-identifier lowercase literals at reason: sites in the
  // controller and the native helper.
  const emitted = new Set()
  for (const source of [controller, swift]) {
    for (const match of source.matchAll(/reason:\s*['"]([a-z][a-z0-9_-]*)(?::\s|['"])/gu)) {
      emitted.add(match[1])
    }
  }
  const vocabulary = new Set(COMPUTER_OMITTED_REASON_VOCABULARY)
  for (const identifier of emitted) {
    assert.ok(
      vocabulary.has(identifier),
      `code emits reason ${identifier} which the README vocabulary does not list`,
    )
  }

  // Presence: every documented member must exist as a quoted literal in at
  // least one of the two sources, so a listed-but-never-emitted reason is
  // caught too.
  const controllerAndSwift = controller + '\n' + swift
  for (const identifier of COMPUTER_OMITTED_REASON_VOCABULARY) {
    const pattern = new RegExp(`['\"]${identifier}(?::|[ '\"])`, 'u')
    assert.ok(pattern.test(controllerAndSwift), `vocabulary member ${identifier} is never emitted in code`)
  }

  // The Chinese README documents the same vocabulary.
  for (const identifier of COMPUTER_OMITTED_REASON_VOCABULARY) {
    assert.ok(chinese.includes(identifier), `README.zh.md must document ${identifier}`)
  }
})

