import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createComputerTools } from '../lib/index.js'

test('raw definitions pass the locally available DSH host schema validator', async t => {
  const store = join(import.meta.dirname, '..', '..', 'dsh-crew', 'node_modules', '.pnpm')
  let entry
  try {
    entry = (await readdir(store)).find(name => name.startsWith('@deepseek-ai+dsh-tools@'))
  } catch {
    t.skip('sibling DSH host packages are not available in this checkout')
    return
  }
  if (!entry) return t.skip('sibling dsh-tools package is unavailable')
  const modulePath = join(store, entry, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')
  const { assertObjectJsonSchema, assertSupportedJsonSchema } = await import(pathToFileURL(modulePath).href)
  const inertDriver = {
    kind: 'computer', platform: 'macos', contractVersion: 1,
    async observe() {}, async act() {}, async evidence() {}, async disposeScope() {}, async dispose() {},
  }
  const tools = createComputerTools(inertDriver)
  for (const tool of Object.values(tools)) {
    assert.doesNotThrow(() => assertObjectJsonSchema(tool.parameters), `${tool.name} parameters`)
    assert.doesNotThrow(() => assertSupportedJsonSchema(tool.output.schema), `${tool.name} output`)
  }
})
