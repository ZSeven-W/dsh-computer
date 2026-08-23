<h1 align="center">DSH Computer</h1>

<p align="center">
  <strong>A headless-first macOS Computer Use driver that refuses to act on yesterday's screen.</strong><br />
  <sub>Bounded Accessibility observation &bull; Expiring opaque refs &bull; Live identity preflight &bull; Deterministic safety policy &bull; Action receipts</sub>
</p>

<p align="center">
  <sub>Package: <code>@zseven-w/dsh-computer</code> &middot; Local candidate: <code>0.1.0-rc.1</code> &middot; Runtime: macOS + Node.js <code>&gt;=24.11.0</code></sub>
</p>

<p align="center">
  <a href="./README.md"><b>English</b></a> &middot; <a href="./README.zh.md">简体中文</a>
</p>

## Why another Computer Use driver?

Seeing a button once is not authority to click it later. Windows move, applications restart, PIDs are reused, dynamic UIs rebind children, and another Agent can be operating at the same time. DSH Computer treats every observation as a short-lived capability rather than a bag of coordinates.

```text
computer_observe
  explicit/frontmost app + explicit/focused window
  bundle id + PID + launch identity
  window number (or composite identity)
  role + name + identifier + frame
           │
           ▼ opaque ref, scoped to one live Agent, expires in <= 30s
computer_act
  resolve the ref only inside that Agent scope
  re-observe app/process/window/target
  reject stale, rebound, secure, or deterministic high-risk targets
  perform one safe action
           │
           ▼
receipt: confirmed | unknown | rejected | failed
  + post-action observation when available
```

The first vertical slice deliberately has no settings page. It exposes three headless tools and a reusable Cordis driver service for `dsh-qa`.

## Tools

| Tool | Contract |
| --- | --- |
| `computer_observe` | Bounded Accessibility tree for one macOS app/window. Returns opaque refs, a fingerprint, and an expiry. |
| `computer_act` | Safe `click`, `focus`, `type`, or `key` against one fresh ref. Re-observes identity before every action. |
| `computer_evidence` | Helper/permission readiness and recent receipts for the current Agent only. |

Model arguments never contain an Agent id, an AX path, a PID lease, or a caller-supplied `sensitive` flag. The host supplies the live Agent identity; raw AX locators stay inside the driver.

## Safety and outcome semantics

- Observations are scoped to `exec.agent.id`; agentless tool calls are rejected.
- Refs are random, opaque, retained only in memory, and expire after 1–30 seconds.
- An observation is single-mutation: after any accepted or potentially executed action, every ref from that observation is invalidated and the Agent must observe again.
- Action preflight compares exact bundle id, PID, launch identity, window identity, role/subrole, name, identifier, frame, and secure role.
- Secure text entry is always rejected.
- Destructive, financial, and send/publish/share semantics are rejected by deterministic policy in both Node and Swift. Key actions use an explicit navigation-only allowlist; printable shortcuts—including `Control-J`/`Control-M`—are rejected. The model cannot opt out.
- `Return`/`Enter` commit keys are blocked entirely until a host-owned approval flow exists, so `type → Return` cannot turn safe text entry into an unreviewed send, command, or submission.
- A successful input dispatch is not automatically a successful user outcome. `unknown` is returned when the helper cannot prove the visible effect.
- A click is confirmed only when the same revalidated target exposes an action-specific value transition. A missing, replaced, moved, or merely focused target remains `unknown`.
- If transport is lost after an action may have reached the helper, the receipt is `unknown`, never falsely `failed` and therefore never safe to retry blindly.
- Every native request is cancellable. Per-Agent processes and observations are cleared on scope/plugin disposal.
- Agents waiting on the same first-use Swift build cancel independently; one Agent cannot kill another Agent's build wait. The shared compiler process is terminated only when the last waiter leaves or the plugin is disposed.
- The declared `global-hook` capability is used only to observe `agent/disposed` and tear down that Agent's state; this plugin does not read or rewrite Agent messages.

This release only denies high-risk operations; it does not implement an approval flow.

## Driver contract for dsh-qa

The plugin provides the Cordis service `zsevenComputerDriver` and exports its structural TypeScript contract:

```ts
import {
  COMPUTER_DRIVER_SERVICE,
  type ComputerDriver,
  type ComputerActionReceipt,
} from '@zseven-w/dsh-computer/driver'

ctx.inject([COMPUTER_DRIVER_SERVICE], (driverCtx) => {
  const driver = driverCtx[COMPUTER_DRIVER_SERVICE] as ComputerDriver
  // scopeId must come from the trusted live Agent/session, not model input.
})
```

`contractVersion` is currently `1`. Consumers must branch on that value before relying on later fields.

## Local install

This candidate is intentionally local-only: it has not been published or installed into `/Applications`.

```sh
pnpm install
pnpm build
dsh plugin --profile web add link:/absolute/path/to/dsh-computer
dsh web
```

The Swift helper source ships with the plugin. A development checkout builds it with SwiftPM; a packed install can build the same helper lazily into the current user's cache on first native request. Set `DSH_COMPUTER_HELPER` only to select an explicit executable for development or controlled deployment.

Before observing UI, macOS must report Accessibility access for the process that runs the helper. `computer_evidence` reports the current state; it does not open System Settings or claim that permission has been granted.

## Develop and verify

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm build
pnpm run smoke:pack
```

Acceptance includes Node unit tests, Swift pure-policy/identity tests, a real Swift helper build and protocol status handshake, and `npm pack` → clean `npm install`. On macOS the clean install lazily builds its own packed Helper, runs status plus a bounded observation (never an action), and then reaches quiescence. The smoke also asserts that no `@deepseek-ai/*` package is pulled into `node_modules`.

## Current limits

- macOS only. The package still installs elsewhere so a DSH profile can explain the unsupported platform instead of failing activation; native actions remain unavailable.
- Accessibility semantics only: no screenshot vision, OCR, coordinate clicking, scrolling, dragging, clipboard automation, or full IME simulation in this slice.
- `type` uses a settable Accessibility value; it is not a general replacement for natural keyboard/IME input.
- Some applications expose incomplete AX names, identifiers, frames, window numbers, or actions. Missing strong launch identity makes action preflight fail closed.
- The helper binary is not signed, notarized, or shipped prebuilt in this local candidate.
- CI verifies policy, identity, packaging, and the native protocol. Real long-running workflows across multiple displays, Spaces/Stage Manager, focus contention, Chinese IME, and a TCC-granted action path are not yet verified.

## License

[MIT](./LICENSE)
