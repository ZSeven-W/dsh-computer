import type { ComputerAction, ComputerModifier, ComputerTarget } from './contracts.js'

const HIGH_RISK_PATTERNS = [
  /\b(delete|erase|remove|uninstall|destroy|wipe)\b/iu,
  /\b(pay|purchase|buy now|checkout|transfer|wire|send money|place order)\b/iu,
  /\b(send|publish|post|submit|share)\b/iu,
  /删除|清除|抹掉|卸载|销毁|付款|支付|购买|下单|转账|汇款|发送|发布|提交|分享/u,
]

const COMMIT_KEYS = new Set(['return', 'enter', 'numpadenter', '\n', '\r', '↩'])

// A cross-application driver cannot assume an app's printable-key shortcuts
// are harmless. Until host-owned approval exists, key actions are navigation
// only; text entry belongs in the separately guarded `type` action.
const SAFE_KEY_CHORDS = new Set([
  'tab', 'shift+tab', 'escape',
  'left', 'right', 'up', 'down',
  'shift+left', 'shift+right', 'shift+up', 'shift+down',
  'option+left', 'option+right',
  'option+shift+left', 'option+shift+right',
  'home', 'end', 'pageup', 'pagedown',
  'shift+home', 'shift+end', 'shift+pageup', 'shift+pagedown',
])

function targetSemantics(target: Pick<ComputerTarget, 'name' | 'identifier' | 'role' | 'subrole'>): string {
  return [target.name, target.identifier, target.role, target.subrole]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .normalize('NFKC')
}

export function deterministicRiskReason(
  action: ComputerAction,
  target: Pick<ComputerTarget, 'name' | 'identifier' | 'role' | 'subrole' | 'secure'>,
): string | null {
  if (action.kind === 'type' && target.secure) {
    return 'secure text entry is blocked'
  }

  if (action.kind === 'key') {
    const key = action.key.trim().toLowerCase()
    if (COMMIT_KEYS.has(key)) {
      return `commit key is blocked until a host-owned approval flow exists: ${key || 'newline'}`
    }
    const normalized = [...new Set<string>(action.modifiers ?? [])].sort().concat(key).join('+')
    if (!SAFE_KEY_CHORDS.has(normalized)) {
      return `key chord is outside the explicit safe navigation allowlist: ${normalized}`
    }
  }

  if (action.kind === 'click' || action.kind === 'key') {
    const semantics = targetSemantics(target)
    for (const pattern of HIGH_RISK_PATTERNS) {
      if (pattern.test(semantics)) return `high-risk target semantics are blocked: ${pattern.source}`
    }
  }
  return null
}

export function normalizeModifiers(value: readonly string[] | undefined): ComputerModifier[] {
  const allowed = new Set(['command', 'control', 'option', 'shift', 'fn'] as const)
  const result: ComputerModifier[] = []
  for (const item of value ?? []) {
    if (!allowed.has(item as 'command')) throw new Error(`unsupported modifier: ${item}`)
    const modifier = item as 'command' | 'control' | 'option' | 'shift' | 'fn'
    if (!result.includes(modifier)) result.push(modifier)
  }
  return result.sort()
}
