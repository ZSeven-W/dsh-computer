import type { ComputerAction, ComputerModifier, ComputerTarget } from './contracts.js'

interface SemanticRiskPattern {
  readonly category: 'destructive' | 'financial' | 'external-commit'
  readonly pattern: RegExp
}

const HIGH_RISK_PATTERNS: readonly SemanticRiskPattern[] = [
  { category: 'destructive', pattern: /\b(delete|erase|remove|uninstall|destroy|wipe)\b|删除|抹掉|卸载|销毁/iu },
  { category: 'financial', pattern: /\b(pay|purchase|buy now|checkout|transfer|wire|send money|place order)\b|付款|支付|购买|下单|转账|汇款/iu },
  { category: 'external-commit', pattern: /\b(send|publish|post|submit|share)\b|发送|发布|提交|分享/iu },
]

// Web-style and abbreviated names models commonly emit. They must resolve
// before the allow-list check, or a navigation key is gated as unknown.
const KEY_ALIASES = new Map([
  ['esc', 'escape'],
  ['arrowleft', 'left'], ['arrowright', 'right'], ['arrowup', 'up'], ['arrowdown', 'down'],
])

const COMMIT_KEYS = new Set(['return', 'enter', 'numpadenter', '\n', '\r', '↩'])

// A cross-application driver cannot assume an app's printable-key shortcuts
// are harmless. Navigation is the only class that can run without a host
// decision; every other chord is eligible only for a one-action approval.
const SAFE_KEY_CHORDS = new Set([
  'tab', 'shift+tab', 'escape',
  'left', 'right', 'up', 'down',
  'shift+left', 'shift+right', 'shift+up', 'shift+down',
  'option+left', 'option+right',
  'option+shift+left', 'option+shift+right',
  'home', 'end', 'pageup', 'pagedown',
  'shift+home', 'shift+end', 'shift+pageup', 'shift+pagedown',
])

export type ComputerActionRisk =
  | { readonly kind: 'safe' }
  | {
      readonly kind: 'hard-deny'
      readonly code: 'secure-text'
      readonly reason: string
    }
  | {
      readonly kind: 'approval-required'
      readonly code: 'dangerous-click' | 'commit-key' | 'unsafe-key-chord' | 'visual-point-action'
      readonly category: 'destructive' | 'financial' | 'external-commit' | 'commit-key' | 'unsafe-key-chord' | 'visual-point-action'
      readonly reason: string
    }

function targetSemantics(target: Pick<ComputerTarget, 'name' | 'identifier' | 'role' | 'subrole'>): string {
  return [target.name, target.identifier, target.role, target.subrole]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .normalize('NFKC')
}

/** Normalize aliases before dispatch so every approved commit key is executable. */
export function normalizeKeyName(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (value === '\n' || value === '\r' || normalized === '↩' || normalized === 'numpadenter') return 'return'
  if (normalized === 'enter') return 'return'
  return KEY_ALIASES.get(normalized) ?? normalized
}

function normalizedChord(action: Extract<ComputerAction, { kind: 'key' }>): string {
  return [...new Set<string>(action.modifiers ?? [])].sort().concat(normalizeKeyName(action.key)).join('+')
}

/**
 * Deterministic policy computed only from the requested operation and the
 * re-observed AX target. Model-provided risk or approval claims do not exist.
 */
export function classifyComputerActionRisk(
  action: ComputerAction,
  target: Pick<ComputerTarget, 'name' | 'identifier' | 'role' | 'subrole' | 'secure'>,
): ComputerActionRisk {
  if (action.kind === 'type' && target.secure) {
    return { kind: 'hard-deny', code: 'secure-text', reason: 'secure text entry is permanently blocked' }
  }

  if (action.kind === 'key') {
    const key = action.key.trim().toLowerCase()
    if (COMMIT_KEYS.has(key) || action.key === '\n' || action.key === '\r') {
      return {
        kind: 'approval-required',
        code: 'commit-key',
        category: 'commit-key',
        reason: 'commit key requires one-action host approval',
      }
    }
    const chord = normalizedChord(action)
    if (!SAFE_KEY_CHORDS.has(chord)) {
      return {
        kind: 'approval-required',
        code: 'unsafe-key-chord',
        category: 'unsafe-key-chord',
        reason: 'key chord outside the safe navigation allowlist requires one-action host approval',
      }
    }
  }

  if (action.kind === 'click') {
    const semantics = targetSemantics(target)
    const match = HIGH_RISK_PATTERNS.find(candidate => candidate.pattern.test(semantics))
    if (match) {
      return {
        kind: 'approval-required',
        code: 'dangerous-click',
        category: match.category,
        reason: `target semantics indicate a ${match.category} operation and require one-action host approval`,
      }
    }
  }
  return { kind: 'safe' }
}

/**
 * Every coordinate-based visual action operates on an AX-opaque target by
 * definition (the fallback exists precisely when there is no usable AX node).
 * It is therefore always an unknown-AX-target action requiring one host-owned
 * allowed-once decision. The grant binds the exact op, integer pixel coords,
 * capture SHA-256, and window identity elsewhere; this classifier only encodes
 * the unconditional approval requirement. A secure field discovered under the
 * point is hard-denied by the controller/native preflight, never approved.
 */
export function classifyComputerVisualActionRisk(): ComputerActionRisk {
  return {
    kind: 'approval-required',
    code: 'visual-point-action',
    category: 'visual-point-action',
    reason: 'coordinate-based visual action targets an AX-opaque location and requires one-action host approval',
  }
}

/** Backward-compatible summary for consumers that only need deny/ask text. */
export function deterministicRiskReason(
  action: ComputerAction,
  target: Pick<ComputerTarget, 'name' | 'identifier' | 'role' | 'subrole' | 'secure'>,
): string | null {
  const risk = classifyComputerActionRisk(action, target)
  return risk.kind === 'safe' ? null : risk.reason
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
