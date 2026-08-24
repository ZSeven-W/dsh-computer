export const app = {
  bundleId: 'dev.zseven.fixture',
  pid: 4242,
  launchIdentity: '1787500000000000:/Fixture.app/Contents/MacOS/Fixture',
  name: 'Fixture',
}

export const windowIdentity = {
  number: 17,
  role: 'AXWindow',
  subrole: 'AXStandardWindow',
  title: 'Fixture Window',
  frame: { x: 10, y: 20, width: 900, height: 700 },
  identity: 'window-digest',
}

export function node(overrides = {}) {
  return {
    role: 'AXButton',
    subrole: null,
    name: 'Open settings',
    identifier: 'open-settings',
    frame: { x: 30, y: 40, width: 120, height: 28 },
    enabled: true,
    focused: false,
    secure: false,
    actions: ['AXPress'],
    value: null,
    locator: [0, 1],
    depth: 2,
    ...overrides,
  }
}

export function observation(overrides = {}) {
  return {
    capturedAt: '2026-08-24T00:00:00.000Z',
    app,
    window: windowIdentity,
    nodes: [node()],
    truncated: false,
    ...overrides,
  }
}

export function nativeStatus(overrides = {}) {
  return {
    platform: 'macos',
    accessibilityTrusted: true,
    screenRecordingTrusted: true,
    sessionLocked: false,
    interactiveSessionAvailable: true,
    helperVersion: 'fixture',
    helperExecutable: '/Applications/DSH Computer Helper.app/Contents/MacOS/DSH Computer Helper',
    bundle: {
      path: '/Applications/DSH Computer Helper.app',
      identifier: 'io.github.zseven-w.dsh-computer.helper',
      version: '0.1.0-rc.1',
    },
    signing: {
      signed: true,
      kind: 'development',
      codeIdentifier: 'io.github.zseven-w.dsh-computer.helper',
      teamIdentifier: 'FIXTURETEAM',
      authorities: ['Apple Development: Fixture'],
      cdhash: 'abcd',
      statusCode: 0,
      detail: null,
    },
    process: { pid: 9001, ppid: 9000 },
    caller: { pid: 9000, executable: '/usr/local/bin/node', bundleIdentifier: null, name: 'node' },
    resolution: { source: 'installed-app', selectedPath: '/Applications/DSH Computer Helper.app' },
    identityStable: true,
    ...overrides,
  }
}

export class FakeNative {
  constructor(options = {}) {
    this.options = options
    this.requests = []
    this.disposedScopes = []
    this.disposed = false
  }

  async request(request, options) {
    this.requests.push({ request: structuredClone(request), scopeId: options.scopeId })
    if (request.command === 'status') {
      return this.options.status ?? nativeStatus()
    }
    if (request.command === 'observe') return this.options.observation ?? observation()
    if (this.options.actionError) throw this.options.actionError
    return this.options.actionResult ?? {
      status: 'unknown',
      reason: 'AXPress accepted but no state change proven',
      accepted: true,
      post: {
        capturedAt: '2026-08-24T00:00:00.100Z',
        app,
        window: windowIdentity,
        target: node(),
      },
    }
  }

  active() { return 0 }
  async disposeScope(scope) { this.disposedScopes.push(scope) }
  async dispose() { this.disposed = true }
}
