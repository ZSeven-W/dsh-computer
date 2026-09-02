import assert from 'node:assert/strict'
import { access, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createComputerTools } from '../lib/index.js'

async function currentHostModules() {
  const installed = resolve(
    dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules',
  )
  try {
    await access(join(installed, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
    return installed
  } catch { /* fall through to the sibling development checkout */ }

  const store = join(import.meta.dirname, '..', '..', 'dsh-crew', 'node_modules', '.pnpm')
  try {
    const rows = await readdir(store)
    const tools = rows.find(name => name.startsWith('@deepseek-ai+dsh-tools@'))
    if (tools === undefined) return undefined
    return join(store, tools, 'node_modules')
  } catch {
    return undefined
  }
}

test('definitions pass the current DSH schema validator and raw ToolRuntime execution contract', async t => {
  const modules = await currentHostModules()
  if (modules === undefined) return t.skip('a local DSH host runtime is unavailable')
  const modulePath = packageName => pathToFileURL(
    join(modules, '@deepseek-ai', packageName, 'lib', 'index.js'),
  ).href
  const { Context } = await import(modulePath('cordis'))
  const { default: SystemPrompt } = await import(modulePath('dsh-system-prompt'))
  const {
    ToolRuntime, assertObjectJsonSchema, assertSupportedJsonSchema,
  } = await import(modulePath('dsh-tools'))
  const inertDriver = {
    kind: 'computer', platform: 'macos', contractVersion: 4,
    async observe() {}, async visualObserve() {}, async act() {}, async evidence() {}, async disposeScope() {}, async dispose() {},
  }
  const tools = createComputerTools(inertDriver)
  for (const tool of Object.values(tools)) {
    assert.doesNotThrow(() => assertObjectJsonSchema(tool.parameters), `${tool.name} parameters`)
    assert.doesNotThrow(() => assertSupportedJsonSchema(tool.output.schema), `${tool.name} output`)
  }

  const runtimeDriver = {
    ...inertDriver,
    async evidence() {
      return {
        contractVersion: 4,
        scope: 'runtime-scope',
        status: {
          platform: 'macos', helper: 'unavailable', accessibilityTrusted: null,
          screenRecordingTrusted: null, sessionLocked: null, interactiveSessionAvailable: null,
          helperVersion: null, helperExecutable: null, bundle: null, signing: null,
          process: null, caller: null, resolution: null, identityStable: null, detail: 'fixture',
        },
        activeObservations: 0,
        activeNativeRequests: 0,
        receipts: [],
        receipts_total: 0,
        receipts_dropped: 0,
        receipts_returned: 0,
        bounded: true,
      }
    },
  }
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  ctx.tools.register(createComputerTools(runtimeDriver).computerEvidence)
  const execution = {
    signal: new AbortController().signal,
    callId: 'call-runtime-contract',
    name: 'computer_evidence',
    agent: { id: 'agent-runtime-contract' },
  }
  const valid = await ctx.tools.execute({ ...execution, arguments: {} })
  assert.equal(valid.isError, false)
  assert.equal(valid.value.contractVersion, 4)

  const extra = await ctx.tools.execute({ ...execution, callId: 'call-runtime-extra', arguments: { approved: true } })
  assert.equal(extra.isError, true, 'ToolRuntime must surface the executor\'s exact-key refusal')
  assert.match(extra.content[0]?.text ?? '', /unexpected argument approved/u)
})
