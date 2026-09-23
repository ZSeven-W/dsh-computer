// Field report (session.v3, 2026-09-24): two avoidable approval prompts per
// task. `esc` was not normalized to `escape`, so the navigation allow-list
// missed it; and the Chinese list gated 「清除」 while English `Clear` was safe,
// so Calculator's C/AC buttons prompted only in a Chinese locale.
import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyComputerActionRisk, normalizeKeyName } from '../lib/index.js'

const target = (name, identifier) => ({ name, identifier, role: 'AXButton', subrole: undefined, secure: false })

test('escape and arrow aliases normalize to the dispatchable key name', () => {
  for (const [alias, canonical] of [
    ['esc', 'escape'], ['Esc', 'escape'], [' ESC ', 'escape'],
    ['arrowleft', 'left'], ['ArrowRight', 'right'], ['ARROWUP', 'up'], ['arrowdown', 'down'],
  ]) {
    assert.equal(normalizeKeyName(alias), canonical, alias)
    assert.deepEqual(classifyComputerActionRisk({ kind: 'key', key: alias }, target('Editor')), { kind: 'safe' }, alias)
  }
  assert.deepEqual(
    classifyComputerActionRisk({ kind: 'key', key: 'arrowleft', modifiers: ['option'] }, target('Editor')),
    { kind: 'safe' },
  )
})

test('printable keys stay outside the navigation allow-list', () => {
  for (const key of ['7', 'esc7', 'escape2']) {
    assert.equal(classifyComputerActionRisk({ kind: 'key', key }, target('Keypad')).kind, 'approval-required', key)
  }
})

test('clear buttons are not destructive in either language; delete still is', () => {
  for (const [name, identifier] of [['清除', 'Clear'], ['全部清除', 'AllClear'], ['Clear', 'Clear'], ['All Clear', 'AllClear']]) {
    assert.deepEqual(classifyComputerActionRisk({ kind: 'click' }, target(name, identifier)), { kind: 'safe' }, name)
  }
  for (const name of ['删除', '删除备忘录', '抹掉磁盘', '卸载', '销毁', 'Delete note']) {
    const risk = classifyComputerActionRisk({ kind: 'click' }, target(name))
    assert.equal(risk.kind, 'approval-required', name)
    assert.equal(risk.category, 'destructive', name)
  }
})
