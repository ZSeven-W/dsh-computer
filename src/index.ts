import { ComputerController } from './controller.js'
import {
  COMPUTER_DRIVER_SERVICE,
  type ComputerDriver,
} from './contracts.js'
import { COMPUTER_TOOL_NAMES, createComputerTools, type StructuralToolDefinition } from './tools.js'

export * from './contracts.js'
export { ComputerController, type ComputerControllerOptions } from './controller.js'
export { ComputerPlatformError, NativeHelper, NativeHelperError, type NativeHelperOptions } from './native-helper.js'
export { deterministicRiskReason, normalizeModifiers } from './policy.js'
export { COMPUTER_TOOL_NAMES, createComputerTools } from './tools.js'

export const name = 'dsh-computer'
export const inject = ['tools']

interface HostContext {
  tools: {
    register(tool: StructuralToolDefinition): () => void
  }
  effect(factory: () => void | (() => void) | Promise<void | (() => void)>, label?: string): () => void | Promise<void>
  on?(
    event: 'agent/disposed',
    listener: (payload: { agent?: { id?: unknown } }) => void | Promise<void>,
  ): () => void | Promise<void>
  provide(name: string, value: unknown): () => void | Promise<void>
  logger?: {
    info?(message: string): void
    warn?(message: string): void
  }
}

/** Mount the model tools and the reusable `zsevenComputerDriver` service. */
export function apply(ctx: HostContext): () => Promise<void> {
  const driver: ComputerDriver = new ComputerController()
  const unprovide = ctx.provide(COMPUTER_DRIVER_SERVICE, driver)
  const tools = createComputerTools(driver)
  const disposers: Array<() => void | Promise<void>> = [
    ctx.effect(() => ctx.tools.register(tools.computerObserve), 'dsh-computer:computer_observe'),
    ctx.effect(() => ctx.tools.register(tools.computerAct), 'dsh-computer:computer_act'),
    ctx.effect(() => ctx.tools.register(tools.computerEvidence), 'dsh-computer:computer_evidence'),
  ]
  if (typeof ctx.on === 'function') {
    disposers.push(ctx.on('agent/disposed', async ({ agent }) => {
      const id = agent?.id
      if (typeof id !== 'string' || id === '') return
      try {
        await driver.disposeScope(id)
      } catch (error) {
        ctx.logger?.warn?.(`dsh-computer could not dispose Agent scope ${id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }))
  }
  ctx.logger?.info?.(
    `dsh-computer mounted (${COMPUTER_TOOL_NAMES.join(' + ')}; macOS Accessibility helper builds lazily)`,
  )
  return async () => {
    for (const dispose of disposers.reverse()) await dispose()
    await unprovide()
    await driver.dispose()
  }
}
