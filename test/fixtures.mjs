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
      return { platform: 'macos', accessibilityTrusted: true, helperVersion: 'fixture' }
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
