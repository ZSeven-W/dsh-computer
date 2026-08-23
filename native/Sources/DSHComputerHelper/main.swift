import AppKit
import ApplicationServices
import ComputerCore
import Foundation

private let helperVersion = "0.1.0-rc.1"
private let maxAttributeText = 240
private let maxChildrenPerNode = 80

private struct AppSelector: Codable {
    let bundleId: String?
    let pid: Int32?
}

private struct WindowSelector: Codable {
    let number: Int?
    let title: String?
}

private struct ExpectedTarget: Codable {
    let app: AppIdentity
    let window: WindowIdentity
    let element: ElementIdentity
    let locator: [Int]
}

private struct Request: Codable {
    let id: String
    let command: String
    let app: AppSelector?
    let window: WindowSelector?
    let maxDepth: Int?
    let maxNodes: Int?
    let expected: ExpectedTarget?
    let action: ActionPayload?
}

private struct ErrorPayload: Codable {
    let code: String
    let message: String
}

private struct Response<Result: Codable>: Codable {
    let id: String
    let ok: Bool
    let result: Result?
    let error: ErrorPayload?
}

private struct EmptyResult: Codable {}

private struct StatusResult: Codable {
    let platform: String
    let accessibilityTrusted: Bool
    let helperVersion: String
}

private struct ObservedNode: Codable {
    let role: String
    let subrole: String?
    let name: String?
    let identifier: String?
    let frame: ComputerFrame?
    let enabled: Bool?
    let focused: Bool?
    let secure: Bool
    let actions: [String]
    let value: String?
    let locator: [Int]
    let depth: Int

    var identity: ElementIdentity {
        ElementIdentity(
            role: role, subrole: subrole, name: name, identifier: identifier,
            frame: frame, enabled: enabled, focused: focused, secure: secure,
            actions: actions, value: value
        )
    }
}

private struct ObserveResult: Codable {
    let capturedAt: String
    let app: AppIdentity
    let window: WindowIdentity
    let nodes: [ObservedNode]
    let truncated: Bool
}

private struct PostObservation: Codable {
    let capturedAt: String
    let app: AppIdentity
    let window: WindowIdentity
    let target: ElementIdentity?
}

private struct ActionResult: Codable {
    let status: String
    let reason: String
    let accepted: Bool
    let post: PostObservation?
}

private struct HelperFailure: Error {
    let code: String
    let message: String
}

private struct ResolvedTarget {
    let running: NSRunningApplication
    let appIdentity: AppIdentity
    let appElement: AXUIElement
    let windowElement: AXUIElement
    let windowIdentity: WindowIdentity
}

private func timestamp() -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: Date())
}

private func bounded(_ value: String?) -> String? {
    guard let value else { return nil }
    let normalized = value.replacingOccurrences(of: "\u{0000}", with: "")
    if normalized.count <= maxAttributeText { return normalized }
    return String(normalized.prefix(maxAttributeText))
}

private func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name, &value) == .success else { return nil }
    return value
}

private func stringAttribute(_ element: AXUIElement, _ name: CFString) -> String? {
    bounded(attribute(element, name) as? String)
}

private func boolAttribute(_ element: AXUIElement, _ name: CFString) -> Bool? {
    if let value = attribute(element, name) as? Bool { return value }
    if let value = attribute(element, name) as? NSNumber { return value.boolValue }
    return nil
}

private func intAttribute(_ element: AXUIElement, _ name: CFString) -> Int? {
    if let value = attribute(element, name) as? NSNumber { return value.intValue }
    return nil
}

private func elementAttribute(_ element: AXUIElement, _ name: CFString) -> AXUIElement? {
    guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return unsafeDowncast(value, to: AXUIElement.self)
}

private func elementArrayAttribute(_ element: AXUIElement, _ name: CFString) -> [AXUIElement] {
    guard let value = attribute(element, name), CFGetTypeID(value) == CFArrayGetTypeID() else { return [] }
    let array = value as! CFArray
    let count = min(CFArrayGetCount(array), maxChildrenPerNode)
    var elements: [AXUIElement] = []
    elements.reserveCapacity(count)
    for index in 0..<count {
        let raw = CFArrayGetValueAtIndex(array, index)
        let value = unsafeBitCast(raw, to: CFTypeRef.self)
        if CFGetTypeID(value) == AXUIElementGetTypeID() {
            elements.append(unsafeDowncast(value, to: AXUIElement.self))
        }
    }
    return elements
}

private func pointAttribute(_ element: AXUIElement, _ name: CFString) -> CGPoint? {
    guard let raw = attribute(element, name), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    let value = unsafeDowncast(raw, to: AXValue.self)
    var point = CGPoint.zero
    return AXValueGetValue(value, .cgPoint, &point) ? point : nil
}

private func sizeAttribute(_ element: AXUIElement, _ name: CFString) -> CGSize? {
    guard let raw = attribute(element, name), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    let value = unsafeDowncast(raw, to: AXValue.self)
    var size = CGSize.zero
    return AXValueGetValue(value, .cgSize, &size) ? size : nil
}

private func frameOf(_ element: AXUIElement) -> ComputerFrame? {
    guard let point = pointAttribute(element, kAXPositionAttribute as CFString),
          let size = sizeAttribute(element, kAXSizeAttribute as CFString),
          point.x.isFinite, point.y.isFinite, size.width.isFinite, size.height.isFinite else { return nil }
    return ComputerFrame(x: point.x, y: point.y, width: size.width, height: size.height)
}

private func actionNames(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success, let names else { return [] }
    return (names as? [String] ?? []).sorted()
}

private func isSecure(role: String, subrole: String?, identifier: String?) -> Bool {
    [role, subrole, identifier]
        .compactMap { $0?.lowercased() }
        .contains { $0.contains("securetextfield") || $0.contains("password") }
}

private func identityOf(_ element: AXUIElement) -> ElementIdentity {
    let role = stringAttribute(element, kAXRoleAttribute as CFString) ?? "AXUnknown"
    let subrole = stringAttribute(element, kAXSubroleAttribute as CFString)
    let identifier = stringAttribute(element, kAXIdentifierAttribute as CFString)
    let secure = isSecure(role: role, subrole: subrole, identifier: identifier)
    let title = stringAttribute(element, kAXTitleAttribute as CFString)
    let description = stringAttribute(element, kAXDescriptionAttribute as CFString)
    let help = stringAttribute(element, kAXHelpAttribute as CFString)
    let value = secure ? nil : stringAttribute(element, kAXValueAttribute as CFString)
    return ElementIdentity(
        role: role,
        subrole: subrole,
        name: title ?? description ?? help,
        identifier: identifier,
        frame: frameOf(element),
        enabled: boolAttribute(element, kAXEnabledAttribute as CFString),
        focused: boolAttribute(element, kAXFocusedAttribute as CFString),
        secure: secure,
        actions: actionNames(element),
        value: value
    )
}

private func observedNode(_ element: AXUIElement, locator: [Int], depth: Int) -> ObservedNode {
    let identity = identityOf(element)
    return ObservedNode(
        role: identity.role, subrole: identity.subrole, name: identity.name,
        identifier: identity.identifier, frame: identity.frame, enabled: identity.enabled,
        focused: identity.focused, secure: identity.secure, actions: identity.actions,
        value: identity.value, locator: locator, depth: depth
    )
}

private func appIdentity(_ running: NSRunningApplication) throws -> AppIdentity {
    guard let bundleId = running.bundleIdentifier, !bundleId.isEmpty else {
        throw HelperFailure(code: "unidentified_application", message: "target application has no bundle identifier")
    }
    let launchIdentity: String?
    if let launchDate = running.launchDate {
        let micros = Int64((launchDate.timeIntervalSince1970 * 1_000_000).rounded())
        let executable = running.executableURL?.standardizedFileURL.path ?? ""
        launchIdentity = "\(micros):\(executable)"
    } else {
        launchIdentity = nil
    }
    return AppIdentity(
        bundleId: bundleId,
        pid: running.processIdentifier,
        launchIdentity: launchIdentity,
        name: bounded(running.localizedName)
    )
}

private func resolveApplication(_ selector: AppSelector?) throws -> NSRunningApplication {
    if let pid = selector?.pid {
        guard pid > 0, let running = NSRunningApplication(processIdentifier: pid), !running.isTerminated else {
            throw HelperFailure(code: "application_not_found", message: "no live application has PID \(pid)")
        }
        if let bundle = selector?.bundleId, running.bundleIdentifier != bundle {
            throw HelperFailure(code: "application_mismatch", message: "PID \(pid) does not belong to bundle \(bundle)")
        }
        return running
    }
    if let bundle = selector?.bundleId {
        let matches = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).filter { !$0.isTerminated }
        guard matches.count == 1, let running = matches.first else {
            if matches.isEmpty {
                throw HelperFailure(code: "application_not_found", message: "bundle \(bundle) is not running")
            }
            throw HelperFailure(code: "ambiguous_application", message: "bundle \(bundle) has multiple live processes; pass app_pid")
        }
        return running
    }
    guard let frontmost = NSWorkspace.shared.frontmostApplication, !frontmost.isTerminated else {
        throw HelperFailure(code: "frontmost_application_unavailable", message: "macOS reported no frontmost application")
    }
    return frontmost
}

private func windowIdentity(_ window: AXUIElement) -> WindowIdentity {
    let number = intAttribute(window, "AXWindowNumber" as CFString)
    let role = stringAttribute(window, kAXRoleAttribute as CFString) ?? "AXWindow"
    let subrole = stringAttribute(window, kAXSubroleAttribute as CFString)
    let title = stringAttribute(window, kAXTitleAttribute as CFString)
    let frame = frameOf(window)
    let frameText = frame.map { "\($0.x),\($0.y),\($0.width),\($0.height)" } ?? "nil"
    let digest = stableDigest([number.map(String.init) ?? "nil", role, subrole ?? "", title ?? "", frameText])
    return WindowIdentity(number: number, role: role, subrole: subrole, title: title, frame: frame, identity: digest)
}

private func windows(_ app: AXUIElement) -> [AXUIElement] {
    elementArrayAttribute(app, kAXWindowsAttribute as CFString)
}

private func resolveWindow(app: AXUIElement, selector: WindowSelector?) throws -> AXUIElement {
    let all = windows(app)
    guard !all.isEmpty else { throw HelperFailure(code: "window_not_found", message: "target application exposes no Accessibility windows") }
    if selector?.number != nil || selector?.title != nil {
        let matches = all.filter { candidate in
            let identity = windowIdentity(candidate)
            if let number = selector?.number, identity.number != number { return false }
            if let title = selector?.title, identity.title != title { return false }
            return true
        }
        guard matches.count == 1, let match = matches.first else {
            if matches.isEmpty { throw HelperFailure(code: "window_not_found", message: "no window matches the explicit selector") }
            throw HelperFailure(code: "ambiguous_window", message: "multiple windows match; pass window_number")
        }
        return match
    }
    if let focused = elementAttribute(app, kAXFocusedWindowAttribute as CFString) { return focused }
    if let main = elementAttribute(app, kAXMainWindowAttribute as CFString) { return main }
    guard all.count == 1, let only = all.first else {
        throw HelperFailure(code: "ambiguous_window", message: "application has multiple windows and no focused/main window; pass a selector")
    }
    return only
}

private func resolveExpectedWindow(app: AXUIElement, expected: WindowIdentity) throws -> AXUIElement {
    let all = windows(app)
    let matches = all.filter { candidate in
        let live = windowIdentity(candidate)
        if let number = expected.number { return live.number == number }
        return live.identity == expected.identity
    }
    guard matches.count == 1, let match = matches.first else {
        throw HelperFailure(
            code: "stale_window",
            message: matches.isEmpty ? "observed window no longer exists" : "observed window identity is no longer unique"
        )
    }
    return match
}

private func resolveTarget(selector: AppSelector?, windowSelector: WindowSelector?) throws -> ResolvedTarget {
    guard AXIsProcessTrusted() else {
        throw HelperFailure(
            code: "accessibility_permission_required",
            message: "Accessibility permission is not granted; enable the DSH host in System Settings > Privacy & Security > Accessibility"
        )
    }
    let running = try resolveApplication(selector)
    let identity = try appIdentity(running)
    let app = AXUIElementCreateApplication(running.processIdentifier)
    let window = try resolveWindow(app: app, selector: windowSelector)
    return ResolvedTarget(
        running: running, appIdentity: identity, appElement: app,
        windowElement: window, windowIdentity: windowIdentity(window)
    )
}

private func observe(_ request: Request) throws -> ObserveResult {
    let resolved = try resolveTarget(selector: request.app, windowSelector: request.window)
    let maxDepth = min(8, max(1, request.maxDepth ?? 4))
    let maxNodes = min(500, max(1, request.maxNodes ?? 200))
    var queue: [(AXUIElement, [Int], Int)] = [(resolved.windowElement, [], 0)]
    var index = 0
    var nodes: [ObservedNode] = []
    var seen = Set<CFHashCode>()
    var truncated = false

    while index < queue.count && nodes.count < maxNodes {
        let (element, locator, depth) = queue[index]
        index += 1
        let hash = CFHash(element)
        if seen.contains(hash) { continue }
        seen.insert(hash)
        nodes.append(observedNode(element, locator: locator, depth: depth))
        if depth >= maxDepth { continue }
        let children = elementArrayAttribute(element, kAXChildrenAttribute as CFString)
        for (childIndex, child) in children.enumerated() {
            if queue.count >= maxNodes * 2 {
                truncated = true
                break
            }
            queue.append((child, locator + [childIndex], depth + 1))
        }
    }
    if index < queue.count { truncated = true }
    return ObserveResult(
        capturedAt: timestamp(), app: resolved.appIdentity, window: resolved.windowIdentity,
        nodes: nodes, truncated: truncated
    )
}

private func locate(window: AXUIElement, locator: [Int]) throws -> AXUIElement {
    var current = window
    for (depth, index) in locator.enumerated() {
        let children = elementArrayAttribute(current, kAXChildrenAttribute as CFString)
        guard index >= 0, index < children.count else {
            throw HelperFailure(code: "stale_target", message: "target path changed at depth \(depth)")
        }
        current = children[index]
    }
    return current
}

private func preflight(_ expected: ExpectedTarget) throws -> (ResolvedTarget, AXUIElement, ElementIdentity) {
    guard AXIsProcessTrusted() else {
        throw HelperFailure(code: "accessibility_permission_required", message: "Accessibility permission is not granted")
    }
    guard let running = NSRunningApplication(processIdentifier: expected.app.pid), !running.isTerminated else {
        throw HelperFailure(code: "stale_application", message: "observed application process is no longer running")
    }
    let liveApp = try appIdentity(running)
    if case let .stale(reason) = IdentityVerifier.app(expected: expected.app, live: liveApp) {
        throw HelperFailure(code: "stale_application", message: reason)
    }
    let app = AXUIElementCreateApplication(running.processIdentifier)
    let window = try resolveExpectedWindow(app: app, expected: expected.window)
    let liveWindow = windowIdentity(window)
    if case let .stale(reason) = IdentityVerifier.window(expected: expected.window, live: liveWindow) {
        throw HelperFailure(code: "stale_window", message: reason)
    }
    let element = try locate(window: window, locator: expected.locator)
    let liveElement = identityOf(element)
    if case let .stale(reason) = IdentityVerifier.element(expected: expected.element, live: liveElement) {
        throw HelperFailure(code: "stale_target", message: reason)
    }
    return (
        ResolvedTarget(
            running: running, appIdentity: liveApp, appElement: app,
            windowElement: window, windowIdentity: liveWindow
        ),
        element,
        liveElement
    )
}

private let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
    "o": 31, "u": 32, "i": 34, "p": 35, "return": 36, "enter": 36, "l": 37, "j": 38, "k": 40,
    "n": 45, "m": 46, "tab": 48, "space": 49, "backspace": 51, "escape": 53,
    "delete": 117, "home": 115, "pageup": 116, "end": 119, "pagedown": 121,
    "left": 123, "right": 124, "down": 125, "up": 126,
]

private func flags(_ modifiers: [String]) throws -> CGEventFlags {
    var value: CGEventFlags = []
    for modifier in Set(modifiers) {
        switch modifier {
        case "command": value.insert(.maskCommand)
        case "control": value.insert(.maskControl)
        case "option": value.insert(.maskAlternate)
        case "shift": value.insert(.maskShift)
        case "fn": value.insert(.maskSecondaryFn)
        default: throw HelperFailure(code: "invalid_modifier", message: "unsupported modifier: \(modifier)")
        }
    }
    return value
}

private struct PreparedKey {
    let down: CGEvent
    let up: CGEvent
}

private func prepareKey(key: String, modifiers: [String]) throws -> PreparedKey {
    let normalized = key.trimmingCharacters(in: .whitespaces).lowercased()
    guard let keyCode = keyCodes[normalized] else {
        throw HelperFailure(code: "unsupported_key", message: "unsupported key: \(key)")
    }
    guard let source = CGEventSource(stateID: .hidSystemState),
          let down = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false) else {
        throw HelperFailure(code: "key_event_failed", message: "could not create keyboard event")
    }
    let eventFlags = try flags(modifiers)
    down.flags = eventFlags
    up.flags = eventFlags
    return PreparedKey(down: down, up: up)
}

private func isSettable(_ element: AXUIElement, _ attribute: CFString) -> Bool {
    var settable = DarwinBoolean(false)
    return AXUIElementIsAttributeSettable(element, attribute, &settable) == .success && settable.boolValue
}

private func tryPost(expected: ExpectedTarget) -> PostObservation? {
    guard let running = NSRunningApplication(processIdentifier: expected.app.pid), !running.isTerminated,
          let liveApp = try? appIdentity(running) else { return nil }
    let app = AXUIElementCreateApplication(running.processIdentifier)
    guard let window = try? resolveExpectedWindow(app: app, expected: expected.window) else { return nil }
    let target = try? locate(window: window, locator: expected.locator)
    return PostObservation(
        capturedAt: timestamp(), app: liveApp, window: windowIdentity(window),
        target: target.map(identityOf)
    )
}

private func postIdentityMatches(expected: ExpectedTarget, post: PostObservation?) -> Bool {
    guard let post, let target = post.target else { return false }
    guard case .match = IdentityVerifier.app(expected: expected.app, live: post.app) else { return false }
    guard case .match = IdentityVerifier.window(expected: expected.window, live: post.window) else { return false }
    guard case .match = IdentityVerifier.element(expected: expected.element, live: target) else { return false }
    return true
}

private func unknownAfterMutation(expected: ExpectedTarget, reason: String) -> ActionResult {
    ActionResult(status: "unknown", reason: reason, accepted: true, post: tryPost(expected: expected))
}

private func preflightFailureStatus(_ failure: HelperFailure) -> String {
    if failure.code.hasPrefix("stale_") || failure.code == "accessibility_permission_required"
        || failure.code == "unsupported_key" || failure.code == "invalid_modifier"
        || failure.code == "focus_not_supported" || failure.code == "value_not_settable"
        || failure.code == "invalid_action" {
        return "rejected"
    }
    return "failed"
}

private func actionResult(_ request: Request) -> ActionResult {
    guard let expected = request.expected, let action = request.action else {
        return ActionResult(status: "rejected", reason: "act requires expected target and action", accepted: false, post: nil)
    }
    var mutationStarted = false
    do {
        let (resolved, element, before) = try preflight(expected)
        if let rejection = RiskPolicy.rejection(action: action, target: before) {
            return ActionResult(status: "rejected", reason: rejection, accepted: false, post: nil)
        }
        // Validate every fallible prerequisite before the first AX/CG mutation.
        // Once mutation begins, every later error is an ambiguous outcome.
        var preparedKey: PreparedKey?
        switch action.kind {
        case "click":
            guard before.actions.contains(kAXPressAction as String) else {
                return ActionResult(status: "rejected", reason: "target does not expose AXPress", accepted: false, post: nil)
            }
        case "focus":
            guard isSettable(element, kAXFocusedAttribute as CFString) else {
                throw HelperFailure(code: "focus_not_supported", message: "target does not expose a settable focused attribute")
            }
        case "type":
            guard !before.secure else {
                return ActionResult(status: "rejected", reason: "secure text entry is blocked", accepted: false, post: nil)
            }
            guard let text = action.text, text.count <= 8_192 else {
                throw HelperFailure(code: "invalid_action", message: "type text is missing or too long")
            }
            guard isSettable(element, kAXFocusedAttribute as CFString) else {
                throw HelperFailure(code: "focus_not_supported", message: "target does not expose a settable focused attribute")
            }
            guard isSettable(element, kAXValueAttribute as CFString) else {
                throw HelperFailure(code: "value_not_settable", message: "target value is not settable")
            }
        case "key":
            guard let key = action.key, !key.isEmpty else {
                throw HelperFailure(code: "invalid_action", message: "key is required")
            }
            preparedKey = try prepareKey(key: key, modifiers: action.modifiers ?? [])
            if before.focused != true && !isSettable(element, kAXFocusedAttribute as CFString) {
                throw HelperFailure(code: "focus_not_supported", message: "target cannot be focused before key dispatch")
            }
        default:
            throw HelperFailure(code: "invalid_action", message: "unsupported action: \(action.kind)")
        }

        switch action.kind {
        case "click":
            mutationStarted = true
            let code = AXUIElementPerformAction(element, kAXPressAction as CFString)
            guard code == .success else {
                return unknownAfterMutation(
                    expected: expected,
                    reason: "AXPress was attempted but returned code \(code.rawValue); visible outcome is unknown"
                )
            }
        case "focus":
            mutationStarted = true
            let code = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            guard code == .success else {
                return unknownAfterMutation(
                    expected: expected,
                    reason: "focus mutation was attempted but returned code \(code.rawValue); final state is unknown"
                )
            }
        case "type":
            mutationStarted = true
            let focusCode = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            guard focusCode == .success else {
                return unknownAfterMutation(
                    expected: expected,
                    reason: "focus mutation began before typing but returned code \(focusCode.rawValue); final state is unknown"
                )
            }
            let valueCode = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, action.text! as CFString)
            guard valueCode == .success else {
                return unknownAfterMutation(
                    expected: expected,
                    reason: "focus changed, then setting the value returned code \(valueCode.rawValue); final state is unknown"
                )
            }
        case "key":
            if before.focused != true {
                mutationStarted = true
                let focusCode = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
                guard focusCode == .success else {
                    return unknownAfterMutation(
                        expected: expected,
                        reason: "focus mutation began before key dispatch but returned code \(focusCode.rawValue); final state is unknown"
                    )
                }
            }
            guard let preparedKey else {
                throw HelperFailure(code: "key_event_failed", message: "prepared key event disappeared")
            }
            mutationStarted = true
            preparedKey.down.postToPid(resolved.appIdentity.pid)
            preparedKey.up.postToPid(resolved.appIdentity.pid)
        default:
            break
        }

        let post = tryPost(expected: expected)
        let identityMatches = postIdentityMatches(expected: expected, post: post)
        let confirmed = ActionConfirmation.isConfirmed(
            action: action, before: before, post: post?.target, postIdentityMatches: identityMatches
        )
        switch action.kind {
        case "focus":
            return ActionResult(
                status: confirmed ? "confirmed" : "unknown",
                reason: confirmed ? "target focus was re-observed" : "focus request succeeded but the final focus state was not proven",
                accepted: true, post: post
            )
        case "type":
            return ActionResult(
                status: confirmed ? "confirmed" : "unknown",
                reason: confirmed ? "typed value was re-observed" : "value set succeeded but the final text was not readable or did not match",
                accepted: true, post: post
            )
        case "click":
            return ActionResult(
                status: confirmed ? "confirmed" : "unknown",
                reason: confirmed
                    ? "AXPress succeeded and a value transition was re-observed on the same live target"
                    : "AXPress succeeded but no action-specific effect was proven on the same live target",
                accepted: true, post: post
            )
        default:
            return ActionResult(
                status: "unknown", reason: "keyboard event was dispatched; application effect is not inferable from dispatch alone",
                accepted: true, post: post
            )
        }
    } catch let failure as HelperFailure {
        if mutationStarted {
            return unknownAfterMutation(
                expected: expected,
                reason: "native mutation began before \(failure.code): \(failure.message); final state is unknown"
            )
        }
        return ActionResult(
            status: preflightFailureStatus(failure), reason: "\(failure.code): \(failure.message)",
            accepted: false, post: nil
        )
    } catch {
        if mutationStarted {
            return unknownAfterMutation(
                expected: expected, reason: "native mutation began before an unexpected failure; final state is unknown: \(error)"
            )
        }
        return ActionResult(status: "failed", reason: "native action failed: \(error)", accepted: false, post: nil)
    }
}

private func emit<Result: Codable>(_ response: Response<Result>) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(response), let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

private func handle(_ line: String) {
    let decoder = JSONDecoder()
    let request: Request
    do {
        request = try decoder.decode(Request.self, from: Data(line.utf8))
    } catch {
        emit(Response<EmptyResult>(
            id: "unknown", ok: false, result: nil,
            error: ErrorPayload(code: "invalid_request", message: "request is not valid JSON: \(error)")
        ))
        return
    }

    switch request.command {
    case "status":
        emit(Response(
            id: request.id, ok: true,
            result: StatusResult(platform: "macos", accessibilityTrusted: AXIsProcessTrusted(), helperVersion: helperVersion), error: nil
        ))
    case "observe":
        do {
            emit(Response(id: request.id, ok: true, result: try observe(request), error: nil))
        } catch let failure as HelperFailure {
            emit(Response<ObserveResult>(
                id: request.id, ok: false, result: nil,
                error: ErrorPayload(code: failure.code, message: failure.message)
            ))
        } catch {
            emit(Response<ObserveResult>(
                id: request.id, ok: false, result: nil,
                error: ErrorPayload(code: "observe_failed", message: String(describing: error))
            ))
        }
    case "act":
        emit(Response(id: request.id, ok: true, result: actionResult(request), error: nil))
    default:
        emit(Response<EmptyResult>(
            id: request.id, ok: false, result: nil,
            error: ErrorPayload(code: "unknown_command", message: "unsupported command: \(request.command)")
        ))
    }
}

while let line = readLine() {
    if !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { handle(line) }
}
