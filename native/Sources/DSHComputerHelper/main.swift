import AppKit
@preconcurrency import ApplicationServices
import ComputerCore
import CoreGraphics
import Darwin
import Foundation
import Security

private let helperVersion = "0.1.0-rc.3"
private let helperBundleId = "io.github.zseven-w.dsh-computer.helper"
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

private struct CaptureTargetPayload: Codable {
    let ref: String
    let index: Int
    let element: ElementIdentity
    let locator: [Int]
}

private struct CapturePayload: Codable {
    let app: AppIdentity
    let window: WindowIdentity
    let targets: [CaptureTargetPayload]
    let outputPath: String
}

private struct VisualActPayload: Decodable {
    let app: AppIdentity
    let window: WindowIdentity
    let captureSha256: String
    let targets: [CaptureTargetPayload]
    let action: NativeVisualActionPayload
    let approval: HostApprovalGrant?
}

private struct Request: Decodable {
    let id: String
    let command: String
    let app: AppSelector?
    let window: WindowSelector?
    let maxDepth: Int?
    let maxNodes: Int?
    let expected: ExpectedTarget?
    let action: ActionPayload?
    let approval: HostApprovalGrant?
    let capture: CapturePayload?
    let visual: VisualActPayload?
    let launch: LaunchPayload?
}

private struct LaunchPayload: Decodable {
    let bundleId: String
}

// Explicit encoders: synthesized Codable omits nil optionals, and the Node
// side requires every key to be present (null, not missing).
private struct RunningAppWindow: Codable {
    let number: Int
    let title: String?
    let frame: ComputerFrame

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(number, forKey: .number)
        try container.encode(title, forKey: .title)
        try container.encode(frame, forKey: .frame)
    }
}

private struct RunningApp: Codable {
    let bundleId: String
    let pid: Int32
    let launchIdentity: String?
    let name: String?
    let active: Bool
    let windows: [RunningAppWindow]

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(bundleId, forKey: .bundleId)
        try container.encode(pid, forKey: .pid)
        try container.encode(launchIdentity, forKey: .launchIdentity)
        try container.encode(name, forKey: .name)
        try container.encode(active, forKey: .active)
        try container.encode(windows, forKey: .windows)
    }
}

private struct AppsResult: Codable {
    let apps: [RunningApp]
    let truncated: Bool
    let accessibilityTrusted: Bool
}

private struct LaunchResult: Codable {
    let launched: Bool
    let app: RunningApp
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

private struct HelperBundleIdentity: Codable {
    let path: String?
    let identifier: String?
    let version: String?

    private enum CodingKeys: String, CodingKey { case path, identifier, version }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(path, forKey: .path)
        try container.encode(identifier, forKey: .identifier)
        try container.encode(version, forKey: .version)
    }
}

private struct HelperSigningMetadata: Codable {
    let signed: Bool
    let kind: String
    let codeIdentifier: String?
    let teamIdentifier: String?
    let authorities: [String]
    let cdhash: String?
    let statusCode: Int32
    let detail: String?

    private enum CodingKeys: String, CodingKey {
        case signed, kind, codeIdentifier, teamIdentifier, authorities, cdhash, statusCode, detail
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(signed, forKey: .signed)
        try container.encode(kind, forKey: .kind)
        try container.encode(codeIdentifier, forKey: .codeIdentifier)
        try container.encode(teamIdentifier, forKey: .teamIdentifier)
        try container.encode(authorities, forKey: .authorities)
        try container.encode(cdhash, forKey: .cdhash)
        try container.encode(statusCode, forKey: .statusCode)
        try container.encode(detail, forKey: .detail)
    }
}

private struct HelperProcessIdentity: Codable {
    let pid: Int32
    let ppid: Int32
}

private struct HelperCallerContext: Codable {
    let pid: Int32
    let executable: String?
    let bundleIdentifier: String?
    let name: String?

    private enum CodingKeys: String, CodingKey { case pid, executable, bundleIdentifier, name }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(pid, forKey: .pid)
        try container.encode(executable, forKey: .executable)
        try container.encode(bundleIdentifier, forKey: .bundleIdentifier)
        try container.encode(name, forKey: .name)
    }
}

private struct HelperResolutionIdentity: Codable {
    let source: String
    let selectedPath: String
}

private struct StatusResult: Codable {
    let platform: String
    let accessibilityTrusted: Bool
    let screenRecordingTrusted: Bool
    let sessionLocked: Bool
    let interactiveSessionAvailable: Bool
    let helperVersion: String
    let helperExecutable: String
    let bundle: HelperBundleIdentity
    let signing: HelperSigningMetadata
    let process: HelperProcessIdentity
    let caller: HelperCallerContext
    let resolution: HelperResolutionIdentity
    let identityStable: Bool
}

private struct RawSigningIdentity {
    let signed: Bool
    let codeIdentifier: String?
    let teamIdentifier: String?
    let authorities: [String]
    let cdhash: String?
    let status: OSStatus
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

    private enum CodingKeys: String, CodingKey {
        case role, subrole, name, identifier, frame, enabled, focused, secure, actions, value, locator, depth
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(role, forKey: .role)
        try container.encode(subrole, forKey: .subrole)
        try container.encode(name, forKey: .name)
        try container.encode(identifier, forKey: .identifier)
        try container.encode(frame, forKey: .frame)
        try container.encode(enabled, forKey: .enabled)
        try container.encode(focused, forKey: .focused)
        try container.encode(secure, forKey: .secure)
        try container.encode(actions, forKey: .actions)
        try container.encode(value, forKey: .value)
        try container.encode(locator, forKey: .locator)
        try container.encode(depth, forKey: .depth)
    }
}

private struct ObserveResult: Codable {
    let capturedAt: String
    let app: AppIdentity
    let window: WindowIdentity
    let nodes: [ObservedNode]
    let truncated: Bool
}

private struct CaptureOmission: Codable {
    let ref: String
    let index: Int
    let reason: String
}

private struct CaptureResult: Codable {
    let capturedAt: String
    let app: AppIdentity
    let window: WindowIdentity
    let artifact: VisualCaptureArtifact
    let pointFrame: ComputerFrame
    let pixelWidth: Int
    let pixelHeight: Int
    let scaleX: Double
    let scaleY: Double
    let quality: VisualCaptureQuality
    let marks: [VisualCaptureMark]
    let omitted: [CaptureOmission]
}

private struct PostObservation: Codable {
    let capturedAt: String
    let app: AppIdentity
    let window: WindowIdentity
    let target: ElementIdentity?

    private enum CodingKeys: String, CodingKey {
        case capturedAt, app, window, target
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(capturedAt, forKey: .capturedAt)
        try container.encode(app, forKey: .app)
        try container.encode(window, forKey: .window)
        try container.encode(target, forKey: .target)
    }
}

private struct ActionResult: Codable {
    let status: String
    let reason: String
    let accepted: Bool
    let post: PostObservation?

    private enum CodingKeys: String, CodingKey {
        case status, reason, accepted, post
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(status, forKey: .status)
        try container.encode(reason, forKey: .reason)
        try container.encode(accepted, forKey: .accepted)
        try container.encode(post, forKey: .post)
    }
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

private func cgSessionBoolean(_ dictionary: NSDictionary?, key: String) -> Bool? {
    guard let value = dictionary?[key] else { return nil }
    if let boolean = value as? Bool { return boolean }
    if let number = value as? NSNumber { return number.boolValue }
    return nil
}

private func currentInteractiveSessionAvailability() -> InteractiveSessionAvailability {
    let dictionary = CGSessionCopyCurrentDictionary() as NSDictionary?
    let signals = InteractiveSessionSignals(
        frontmostBundleIdentifier: NSWorkspace.shared.frontmostApplication?.bundleIdentifier,
        loginDone: cgSessionBoolean(dictionary, key: kCGSessionLoginDoneKey),
        onConsole: cgSessionBoolean(dictionary, key: kCGSessionOnConsoleKey),
        // This WindowServer session key is present on supported macOS releases
        // but is not exported as a CoreGraphics Swift constant.
        screenLocked: cgSessionBoolean(dictionary, key: "CGSSessionScreenIsLocked")
    )
    return InteractiveSessionPolicy.evaluate(signals)
}

private func requireInteractiveSession() throws {
    guard currentInteractiveSessionAvailability().interactiveSessionAvailable else {
        throw HelperFailure(
            code: "session_locked",
            message: "macOS interactive desktop session is locked or unavailable"
        )
    }
}

private func accessibilityTrustedWithoutPrompt() -> Bool {
    let promptOption = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    return AXIsProcessTrustedWithOptions([promptOption: false] as CFDictionary)
}

private func canonicalPath(_ path: String) -> String {
    path.withCString { source in
        guard let resolved = realpath(source, nil) else { return path }
        defer { free(resolved) }
        return String(cString: resolved)
    }
}

private func processExecutablePath(pid: pid_t) -> String? {
    // PROC_PIDPATHINFO_MAXSIZE is a C expression macro and is not imported by Swift.
    var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN) * 4)
    let count = buffer.withUnsafeMutableBytes { bytes in
        proc_pidpath(pid, bytes.baseAddress, UInt32(bytes.count))
    }
    guard count > 0 else { return nil }
    return buffer.withUnsafeBufferPointer { pointer in
        guard let baseAddress = pointer.baseAddress else { return nil }
        return canonicalPath(String(cString: baseAddress))
    }
}

private func helperExecutablePath() -> String {
    if let executable = processExecutablePath(pid: getpid()) { return executable }
    if let executable = Bundle.main.executableURL?.resolvingSymlinksInPath().path { return executable }
    return canonicalPath(URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.path)
}

private func enclosingApplicationBundle(for executablePath: String?) -> Bundle? {
    guard let executablePath else { return nil }
    var url = URL(fileURLWithPath: executablePath).deletingLastPathComponent()
    while url.path != "/" {
        if url.pathExtension.lowercased() == "app", let bundle = Bundle(url: url) { return bundle }
        url.deleteLastPathComponent()
    }
    return nil
}

private func certificateAuthority(_ certificate: SecCertificate) -> String? {
    var commonName: CFString?
    guard SecCertificateCopyCommonName(certificate, &commonName) == errSecSuccess,
          let commonName else { return nil }
    return commonName as String
}

private func hexadecimal(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
}

private func rawSigningIdentity() -> RawSigningIdentity {
    var code: SecCode?
    let defaultFlags = SecCSFlags(rawValue: 0)
    let copySelfStatus = SecCodeCopySelf(defaultFlags, &code)
    guard copySelfStatus == errSecSuccess, let code else {
        return RawSigningIdentity(
            signed: false, codeIdentifier: nil, teamIdentifier: nil,
            authorities: [], cdhash: nil, status: copySelfStatus
        )
    }

    // Swift imports SecCode and SecStaticCode as distinct types. Convert through
    // the public API rather than relying on their underlying CoreFoundation shape.
    var staticCode: SecStaticCode?
    let copyStaticStatus = SecCodeCopyStaticCode(code, defaultFlags, &staticCode)
    guard copyStaticStatus == errSecSuccess, let staticCode else {
        return RawSigningIdentity(
            signed: false, codeIdentifier: nil, teamIdentifier: nil,
            authorities: [], cdhash: nil, status: copyStaticStatus
        )
    }

    var rawInformation: CFDictionary?
    let signingFlags = SecCSFlags(rawValue: kSecCSSigningInformation)
    let copyInfoStatus = SecCodeCopySigningInformation(staticCode, signingFlags, &rawInformation)
    guard copyInfoStatus == errSecSuccess, let rawInformation else {
        return RawSigningIdentity(
            signed: false, codeIdentifier: nil, teamIdentifier: nil,
            authorities: [], cdhash: nil, status: copyInfoStatus
        )
    }

    let information = rawInformation as NSDictionary
    let identifier = information[kSecCodeInfoIdentifier] as? String
    let teamIdentifier = information[kSecCodeInfoTeamIdentifier] as? String
    let certificates = information[kSecCodeInfoCertificates] as? [SecCertificate] ?? []
    return RawSigningIdentity(
        signed: identifier != nil,
        codeIdentifier: identifier,
        teamIdentifier: teamIdentifier,
        authorities: certificates.compactMap(certificateAuthority),
        cdhash: (information[kSecCodeInfoUnique] as? Data).map(hexadecimal),
        status: copyInfoStatus
    )
}

private func signingKind(_ signing: RawSigningIdentity) -> String {
    guard signing.signed else { return "unsigned" }
    guard signing.teamIdentifier != nil else { return "adhoc" }
    let leaf = signing.authorities.first?.lowercased() ?? ""
    if leaf.contains("developer id application") { return "developer-id" }
    if leaf.contains("apple development") { return "development" }
    if leaf.contains("apple distribution") || leaf.contains("mac app distribution") { return "distribution" }
    return "other"
}

private func signingDetail(_ status: OSStatus) -> String? {
    guard status != errSecSuccess else { return nil }
    return SecCopyErrorMessageString(status, nil) as String?
}

private func makeStatus() -> StatusResult {
    let session = currentInteractiveSessionAvailability()
    let executable = helperExecutablePath()
    let applicationBundle = enclosingApplicationBundle(for: executable)
    let parentPID = getppid()
    let parentExecutable = processExecutablePath(pid: parentPID)
    let runningParent = NSRunningApplication(processIdentifier: parentPID)
    let parentBundle = runningParent?.bundleURL.flatMap(Bundle.init(url:))
        ?? enclosingApplicationBundle(for: parentExecutable)
    let signing = rawSigningIdentity()
    let signatureKind = signingKind(signing)
    let shortVersion = applicationBundle?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    let buildVersion = applicationBundle?.object(forInfoDictionaryKey: "CFBundleVersion") as? String

    // identityStable is computed from the actual code signature, not from a
    // build flag. A stable TCC identity requires a certificate-backed (non
    // ad-hoc) signature with the fixed bundle identifier and a TeamIdentifier.
    let stableBundleIdentity = applicationBundle?.bundleIdentifier == helperBundleId
        && signing.signed
        && signing.teamIdentifier != nil
        && signing.codeIdentifier == helperBundleId
        && signatureKind != "adhoc"
        && signatureKind != "unsigned"
        && signing.status == errSecSuccess

    return StatusResult(
        platform: "macos",
        accessibilityTrusted: accessibilityTrustedWithoutPrompt(),
        screenRecordingTrusted: CGPreflightScreenCaptureAccess(),
        sessionLocked: session.sessionLocked,
        interactiveSessionAvailable: session.interactiveSessionAvailable,
        helperVersion: helperVersion,
        helperExecutable: executable,
        bundle: HelperBundleIdentity(
            path: applicationBundle.map { canonicalPath($0.bundlePath) },
            identifier: applicationBundle?.bundleIdentifier,
            version: shortVersion ?? buildVersion
        ),
        signing: HelperSigningMetadata(
            signed: signing.signed,
            kind: signingKind(signing),
            codeIdentifier: signing.codeIdentifier,
            teamIdentifier: signing.teamIdentifier,
            authorities: signing.authorities,
            cdhash: signing.cdhash,
            statusCode: signing.status,
            detail: signingDetail(signing.status)
        ),
        process: HelperProcessIdentity(pid: getpid(), ppid: parentPID),
        caller: HelperCallerContext(
            pid: parentPID,
            executable: parentExecutable,
            bundleIdentifier: runningParent?.bundleIdentifier ?? parentBundle?.bundleIdentifier,
            name: runningParent?.localizedName
                ?? parentBundle?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
                ?? parentBundle?.object(forInfoDictionaryKey: "CFBundleName") as? String
                ?? parentExecutable.map { URL(fileURLWithPath: $0).lastPathComponent }
        ),
        // The native process reports its own signature-derived identity here.
        // The Node resolver additionally attests how the binary was selected and
        // may overwrite identityStable for the fixed installed-app path after
        // its own deep validation.
        resolution: HelperResolutionIdentity(source: "cache-build", selectedPath: executable),
        identityStable: stableBundleIdentity
    )
}

private func accessibilityPermissionMessage() -> String {
    "Accessibility permission is not granted for DSH Computer Helper (\(helperExecutablePath())); "
        + "enable that exact Helper in System Settings > Privacy & Security > Accessibility"
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

/// AXValue is not uniformly textual: checkboxes, radio buttons, sliders and
/// several native controls expose NSNumber. Normalize those scalar values to a
/// bounded string so action receipts can prove real state transitions without
/// widening the public JSON contract to arbitrary CoreFoundation values.
private func scalarValueAttribute(_ element: AXUIElement, _ name: CFString) -> String? {
    guard let value = attribute(element, name) else { return nil }
    if let string = value as? String { return bounded(string) }
    if let number = value as? NSNumber { return bounded(number.stringValue) }
    return nil
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

private func doubleAttribute(_ element: AXUIElement, _ name: CFString) -> Double? {
    if let value = attribute(element, name) as? NSNumber { return value.doubleValue }
    return nil
}

private func elementAttribute(_ element: AXUIElement, _ name: CFString) -> AXUIElement? {
    guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return unsafeDowncast(value, to: AXUIElement.self)
}

/// Children read with completeness semantics for the observation walk. A
/// failed attribute call, a clamped array, or a non-AX array entry is an
/// incomplete read: nodes may exist that were not emitted, and the walk must
/// surface truncated instead of silently reporting an absence.
private func readChildren(_ element: AXUIElement) -> ChildrenRead {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success else {
        return ChildrenRead(elements: [], complete: false)
    }
    return ChildrenRead.from(raw: value, ceiling: maxChildrenPerNode)
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
    let value = secure ? nil : scalarValueAttribute(element, kAXValueAttribute as CFString)
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

private func coreGraphicsWindowCandidates(ownerPID: pid_t) -> [WindowMetadataCandidate] {
    guard ownerPID > 0,
          let records = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] else {
        return []
    }
    return records.compactMap { record in
        guard let numberValue = record[kCGWindowNumber as String] as? NSNumber,
              let ownerValue = record[kCGWindowOwnerPID as String] as? NSNumber,
              ownerValue.int32Value == ownerPID,
              let layerValue = record[kCGWindowLayer as String] as? NSNumber,
              layerValue.intValue == Int(CGWindowLevelForKey(.normalWindow)),
              let boundsDictionary = record[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: boundsDictionary as CFDictionary),
              bounds.origin.x.isFinite,
              bounds.origin.y.isFinite,
              bounds.width.isFinite,
              bounds.height.isFinite,
              bounds.width > 0,
              bounds.height > 0 else { return nil }
        return WindowMetadataCandidate(
            number: numberValue.intValue,
            ownerPID: ownerValue.int32Value,
            layer: layerValue.intValue,
            frame: ComputerFrame(
                x: bounds.origin.x,
                y: bounds.origin.y,
                width: bounds.width,
                height: bounds.height
            ),
            title: bounded(record[kCGWindowName as String] as? String)
        )
    }
}

private func inferredWindowNumber(
    _ window: AXUIElement,
    frame: ComputerFrame?,
    title: String?
) -> Int? {
    var ownerPID: pid_t = 0
    guard AXUIElementGetPid(window, &ownerPID) == .success, ownerPID > 0 else { return nil }
    // CGWindowListCopyWindowInfo is a metadata-only query. It neither captures
    // pixels nor invokes CGRequestScreenCaptureAccess, so this fallback cannot
    // prompt for Screen Recording permission.
    return WindowNumberMatcher.uniqueWindowNumber(
        ownerPID: ownerPID,
        accessibilityFrame: frame,
        accessibilityTitle: title,
        candidates: coreGraphicsWindowCandidates(ownerPID: ownerPID)
    )
}

private func windowIdentity(_ window: AXUIElement) -> WindowIdentity {
    let explicitNumber = intAttribute(window, "AXWindowNumber" as CFString)
    let role = stringAttribute(window, kAXRoleAttribute as CFString) ?? "AXWindow"
    let subrole = stringAttribute(window, kAXSubroleAttribute as CFString)
    let title = stringAttribute(window, kAXTitleAttribute as CFString)
    let frame = frameOf(window)
    let number = explicitNumber ?? inferredWindowNumber(window, frame: frame, title: title)
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
    try requireInteractiveSession()
    guard AXIsProcessTrusted() else {
        throw HelperFailure(
            code: "accessibility_permission_required",
            message: accessibilityPermissionMessage()
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
    let walk = ObservationWalk(
        maxDepth: maxDepth,
        maxNodes: maxNodes,
        children: { readChildren($0) }
    )
    let walked = walk.walk(window: resolved.windowElement)
    // Do not return an Accessibility snapshot if the desktop locked while the
    // bounded traversal was in flight.
    try requireInteractiveSession()
    return ObserveResult(
        capturedAt: timestamp(), app: resolved.appIdentity, window: resolved.windowIdentity,
        nodes: walked.visited.map { observedNode($0.element, locator: $0.locator, depth: $0.depth) },
        truncated: walked.truncated
    )
}

private func capture(_ request: Request) async throws -> CaptureResult {
    try requireInteractiveSession()
    guard let payload = request.capture else {
        throw HelperFailure(code: "invalid_capture", message: "capture payload is required")
    }
    guard AXIsProcessTrusted() else {
        throw HelperFailure(code: "accessibility_permission_required", message: accessibilityPermissionMessage())
    }
    guard payload.targets.count <= 200 else {
        throw HelperFailure(code: "invalid_capture", message: "capture accepts at most 200 Accessibility targets")
    }
    guard let explicitWindowNumber = payload.window.number, explicitWindowNumber > 0,
          payload.window.frame != nil else {
        throw HelperFailure(
            code: "window_number_required",
            message: "window capture requires an observed window with an explicit number and point frame"
        )
    }
    guard payload.app.launchIdentity != nil,
          let running = NSRunningApplication(processIdentifier: payload.app.pid),
          !running.isTerminated else {
        throw HelperFailure(code: "stale_application", message: "observed application process is no longer running")
    }
    let liveApp = try appIdentity(running)
    if case let .stale(reason) = IdentityVerifier.app(expected: payload.app, live: liveApp) {
        throw HelperFailure(code: "stale_application", message: reason)
    }
    let appElement = AXUIElementCreateApplication(running.processIdentifier)
    let liveWindowElement = try resolveExpectedWindow(app: appElement, expected: payload.window)
    let liveWindow = windowIdentity(liveWindowElement)
    if case let .stale(reason) = IdentityVerifier.window(expected: payload.window, live: liveWindow) {
        throw HelperFailure(code: "stale_window", message: reason)
    }
    guard liveWindow.number == explicitWindowNumber, let livePointFrame = liveWindow.frame else {
        throw HelperFailure(code: "stale_window", message: "live Accessibility window lost its explicit number or point frame")
    }

    var refs = Set<String>()
    var indices = Set<Int>()
    for target in payload.targets {
        guard !target.ref.isEmpty, target.ref.utf8.count <= 256,
              target.index >= 0, target.index < 500,
              target.locator.count <= 8,
              target.locator.allSatisfy({ $0 >= 0 && $0 < maxChildrenPerNode }),
              refs.insert(target.ref).inserted,
              indices.insert(target.index).inserted else {
            throw HelperFailure(
                code: "invalid_capture_targets",
                message: "capture target refs/indices must be unique and locators must stay inside observation bounds"
            )
        }
    }

    var liveTargets: [VisualCaptureTarget] = []
    var omitted: [CaptureOmission] = []
    liveTargets.reserveCapacity(payload.targets.count)
    omitted.reserveCapacity(payload.targets.count)
    for target in payload.targets {
        do {
            let element = try locate(window: liveWindowElement, locator: target.locator)
            let liveElement = identityOf(element)
            if case let .stale(reason) = IdentityVerifier.element(expected: target.element, live: liveElement) {
                omitted.append(CaptureOmission(ref: target.ref, index: target.index, reason: "stale_target: \(reason)"))
                continue
            }
            guard let frame = liveElement.frame else {
                omitted.append(CaptureOmission(ref: target.ref, index: target.index, reason: "target_has_no_frame"))
                continue
            }
            liveTargets.append(VisualCaptureTarget(ref: target.ref, index: target.index, globalFrame: frame))
        } catch let failure as HelperFailure {
            omitted.append(CaptureOmission(
                ref: target.ref,
                index: target.index,
                reason: "\(failure.code): \(failure.message)"
            ))
        }
    }

    // Re-check after AX resolution and immediately before the CG capture. A
    // lock transition must not fall through to a background-window screenshot.
    try requireInteractiveSession()
    let output = try await WindowCaptureEngine.capture(
        windowNumber: explicitWindowNumber,
        ownerPID: liveApp.pid,
        expectedPointFrame: livePointFrame,
        targets: liveTargets,
        outputPath: payload.outputPath
    )
    do {
        try requireInteractiveSession()
    } catch {
        try? FileManager.default.removeItem(atPath: payload.outputPath)
        throw error
    }
    let markedRefs = Set(output.marks.map(\.ref))
    for target in liveTargets where !markedRefs.contains(target.ref) {
        omitted.append(CaptureOmission(
            ref: target.ref,
            index: target.index,
            reason: "target_outside_captured_window"
        ))
    }
    return CaptureResult(
        capturedAt: timestamp(),
        app: liveApp,
        window: liveWindow,
        artifact: output.artifact,
        pointFrame: output.pointFrame,
        pixelWidth: output.pixelWidth,
        pixelHeight: output.pixelHeight,
        scaleX: output.scaleX,
        scaleY: output.scaleY,
        quality: output.quality,
        marks: output.marks,
        omitted: omitted
    )
}

private func makeProtectedCaptureDirectory() throws -> String {
    let directoryName = "dsh-computer-capture-" + UUID().uuidString
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent(directoryName, isDirectory: true)
        .path
    guard mkdir(directory, S_IRWXU) == 0 else {
        throw HelperFailure(code: "temporary_directory_failed", message: "could not create a protected native capture directory")
    }
    return directory
}

private func captureRequest(
    payload: CapturePayload,
    id: String = "visual-internal-capture"
) -> Request {
    Request(
        id: id,
        command: "capture",
        app: nil,
        window: nil,
        maxDepth: nil,
        maxNodes: nil,
        expected: nil,
        action: nil,
        approval: nil,
        capture: payload,
        visual: nil,
        launch: nil
    )
}

private func resolveVisualWindow(
    app: AppIdentity,
    window: WindowIdentity
) throws -> (running: NSRunningApplication, liveApp: AppIdentity, appElement: AXUIElement, liveWindowElement: AXUIElement, liveWindow: WindowIdentity) {
    try requireInteractiveSession()
    guard AXIsProcessTrusted() else {
        throw HelperFailure(code: "accessibility_permission_required", message: accessibilityPermissionMessage())
    }
    guard let running = NSRunningApplication(processIdentifier: app.pid), !running.isTerminated else {
        throw HelperFailure(code: "stale_application", message: "observed application process is no longer running")
    }
    let liveApp = try appIdentity(running)
    if case let .stale(reason) = IdentityVerifier.app(expected: app, live: liveApp) {
        throw HelperFailure(code: "stale_application", message: reason)
    }
    guard let explicitNumber = window.number else {
        throw HelperFailure(code: "window_number_required", message: "visual action requires an observed window with an explicit number")
    }
    let appElement = AXUIElementCreateApplication(running.processIdentifier)
    let liveWindowElement = try resolveExpectedWindow(app: appElement, expected: window)
    let liveWindow = windowIdentity(liveWindowElement)
    if case let .stale(reason) = IdentityVerifier.window(expected: window, live: liveWindow) {
        throw HelperFailure(code: "stale_window", message: reason)
    }
    guard liveWindow.number == explicitNumber, liveWindow.frame != nil else {
        throw HelperFailure(code: "stale_window", message: "live Accessibility window lost its explicit number or point frame")
    }
    return (running, liveApp, appElement, liveWindowElement, liveWindow)
}

private func secureNodeUnder(point: VisualGlobalPoint, window: AXUIElement) -> ElementIdentity? {
    let walk = ObservationWalk(
        maxDepth: 8,
        maxNodes: 500,
        children: { readChildren($0) }
    )
    let result = walk.walk(window: window)
    for visited in result.visited {
        let identity = identityOf(visited.element)
        guard identity.secure, let frame = identity.frame else { continue }
        if point.x >= frame.x, point.x <= frame.x + frame.width,
           point.y >= frame.y, point.y <= frame.y + frame.height {
            return identity
        }
    }
    return nil
}

private func visualPointHitResolvesToExpectedWindow(
    at point: VisualGlobalPoint,
    expectedNumber: Int,
    expectedPID: pid_t,
    expectedWindow: AXUIElement
) -> Bool {
    guard point.x.isFinite, point.y.isFinite else { return false }
    let screenPoint = CGPoint(x: point.x, y: point.y)

    // Keep the existing actual-CG existence/bounds gate, but do not decide
    // occlusion from CGWindowList ordering alone: a full-screen Dock/backdrop
    // record can precede the real target while Accessibility still reports the
    // target as the element under the point.
    guard let records = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] else {
        return false
    }
    let expectedWindowIsOnScreenAtPoint = records.contains { record in
        guard let number = (record[kCGWindowNumber as String] as? NSNumber)?.intValue,
              number == expectedNumber,
              let ownerPID = (record[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
              ownerPID == expectedPID,
              let boundsDictionary = record[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: boundsDictionary as CFDictionary),
              bounds.contains(screenPoint) else { return false }
        return true
    }
    guard expectedWindowIsOnScreenAtPoint else { return false }

    let systemWide = AXUIElementCreateSystemWide()
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(
        systemWide,
        Float(screenPoint.x),
        Float(screenPoint.y),
        &hit
    ) == .success, let hit else {
        return false
    }
    return VisualPointHitProof.resolvesToExpectedWindow(
        from: hit,
        expectedPID: expectedPID,
        expectedWindow: expectedWindow,
        elementPID: { element -> Int32? in
            var pid: pid_t = 0
            guard AXUIElementGetPid(element, &pid) == .success else { return nil }
            return pid
        },
        windowAttribute: { elementAttribute($0, kAXWindowAttribute as CFString) },
        parentAttribute: { elementAttribute($0, kAXParentAttribute as CFString) },
        elementsEqual: { CFEqual($0, $1) }
    )
}

private func visualGlobalPoints(
    action: NativeVisualActionPayload,
    output: CaptureResult
) throws -> [VisualGlobalPoint] {
    let firstPoint = action.point
    var points = [VisualGlobalPoint]()
    guard let start = VisualCoordinateMapper.globalPoint(
        native: firstPoint,
        pointFrame: output.pointFrame,
        scaleX: output.scaleX,
        scaleY: output.scaleY,
        pixelWidth: output.pixelWidth,
        pixelHeight: output.pixelHeight
    ) else {
        throw HelperFailure(code: "invalid_visual_point", message: "visual action point is outside the captured window bounds")
    }
    points.append(start)
    if action.op == "drag" {
        guard let to = action.to else {
            throw HelperFailure(code: "invalid_visual_action", message: "drag requires a destination point")
        }
        guard let destination = VisualCoordinateMapper.globalPoint(
            native: to,
            pointFrame: output.pointFrame,
            scaleX: output.scaleX,
            scaleY: output.scaleY,
            pixelWidth: output.pixelWidth,
            pixelHeight: output.pixelHeight
        ) else {
            throw HelperFailure(code: "invalid_visual_point", message: "drag endpoint is outside the captured window bounds")
        }
        points.append(destination)
    }
    return points
}

private func postMouseClick(at point: VisualGlobalPoint) throws {
    let location = CGPoint(x: point.x, y: point.y)
    guard let source = CGEventSource(stateID: .hidSystemState),
          let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: location, mouseButton: .left),
          let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: location, mouseButton: .left) else {
        throw HelperFailure(code: "mouse_event_failed", message: "could not create mouse click event")
    }
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
}

private func postMouseDrag(from start: VisualGlobalPoint, to destination: VisualGlobalPoint) throws {
    let startPoint = CGPoint(x: start.x, y: start.y)
    let destinationPoint = CGPoint(x: destination.x, y: destination.y)
    guard let source = CGEventSource(stateID: .hidSystemState),
          let down = CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: startPoint, mouseButton: .left),
          let dragged = CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: destinationPoint, mouseButton: .left),
          let up = CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: destinationPoint, mouseButton: .left) else {
        throw HelperFailure(code: "mouse_event_failed", message: "could not create drag event")
    }
    var mouseIsDown = false
    defer {
        if mouseIsDown {
            up.post(tap: .cghidEventTap)
        }
    }
    down.post(tap: .cghidEventTap)
    mouseIsDown = true
    dragged.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    mouseIsDown = false
}

private func postVisualScroll(at point: VisualGlobalPoint, direction: String, amount: ScrollAmount) throws {
    let location = CGPoint(x: point.x, y: point.y)
    let units: CGScrollEventUnit
    let magnitude: Int32
    switch amount {
    case .line:
        units = .line
        magnitude = 3
    case .page:
        units = .line
        magnitude = 10
    case .points(let points):
        units = .pixel
        let rounded = Int32(max(1.0, min(2_000.0, points.rounded())))
        magnitude = rounded
    }
    let signed = direction == "up" ? magnitude : -magnitude
    guard let source = CGEventSource(stateID: .hidSystemState),
          let event = CGEvent(
            scrollWheelEvent2Source: source,
            units: units,
            wheelCount: 1,
            wheel1: signed,
            wheel2: 0,
            wheel3: 0
          ) else {
        throw HelperFailure(code: "scroll_event_failed", message: "could not create visual scroll event")
    }
    event.location = location
    event.post(tap: .cghidEventTap)
}

private func visualActionResult(_ request: Request) async -> ActionResult {
    guard let payload = request.visual else {
        return ActionResult(
            status: "rejected",
            reason: "visual-act requires a visual payload",
            accepted: false,
            post: nil
        )
    }
    guard payload.action.op == "click" || payload.action.op == "drag" || payload.action.op == "scroll" else {
        return ActionResult(
            status: "rejected",
            reason: "unsupported visual action op: \(payload.action.op)",
            accepted: false,
            post: nil
        )
    }
    do {
        if let rejection = VisualActionPolicy.rejection(
            captureSha256: payload.captureSha256,
            action: payload.action,
            window: payload.window,
            approval: payload.approval
        ) {
            return ActionResult(status: "rejected", reason: rejection, accepted: false, post: nil)
        }
        guard payload.captureSha256.utf8.count == 64,
              payload.captureSha256.utf8.allSatisfy({
                  ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102)
              }) else {
            return ActionResult(
                status: "rejected",
                reason: "visual capture SHA-256 must be lowercase hex",
                accepted: false,
                post: nil
            )
        }

        // Resolve before recapturing so identity/liveness and the recapture
        // use the same app/window context as closely as possible.
        _ = try resolveVisualWindow(app: payload.app, window: payload.window)
        let protectedDirectory = try makeProtectedCaptureDirectory()
        defer { try? FileManager.default.removeItem(atPath: protectedDirectory) }
        let capturePayload = CapturePayload(
            app: payload.app,
            window: payload.window,
            targets: payload.targets,
            outputPath: protectedDirectory + "/capture.png"
        )
        let output = try await capture(captureRequest(payload: capturePayload))
        guard output.artifact.sha256 == payload.captureSha256 else {
            return ActionResult(
                status: "rejected",
                reason: "recaptured overlay SHA-256 does not match the delivered capture; window content changed",
                accepted: false,
                post: nil
            )
        }

        let points = try visualGlobalPoints(action: payload.action, output: output)
        if let failure = VisualActionPathValidator.failure(
            action: payload.action,
            pixelWidth: output.pixelWidth,
            pixelHeight: output.pixelHeight
        ) {
            return ActionResult(status: "rejected", reason: failure, accepted: false, post: nil)
        }

        // Re-resolve after the fresh capture. A window move or process relaunch
        // after capture must not be dispatched through stale geometry.
        let after = try resolveVisualWindow(app: payload.app, window: payload.window)
        guard let liveFrame = after.liveWindow.frame,
              liveFrame.approximatelyEquals(output.pointFrame, tolerance: 2.0) else {
            return ActionResult(
                status: "rejected",
                reason: "window geometry changed after the fresh recapture; visual action was not dispatched",
                accepted: false,
                post: nil
            )
        }
        for point in points {
            if secureNodeUnder(point: point, window: after.liveWindowElement) != nil {
                return ActionResult(
                    status: "rejected",
                    reason: "secure text field under the visual point is permanently blocked; visual action was not dispatched",
                    accepted: false,
                    post: nil
                )
            }
            guard visualPointHitResolvesToExpectedWindow(
                at: point,
                expectedNumber: payload.window.number ?? -1,
                expectedPID: after.liveApp.pid,
                expectedWindow: after.liveWindowElement
            ) else {
                return ActionResult(
                    status: "rejected",
                    reason: "target window is not the visible window resolved by system Accessibility at the visual point; visual action was not dispatched",
                    accepted: false,
                    post: nil
                )
            }
        }

        // One final session check immediately before posting.
        try requireInteractiveSession()

        // The helper exits after its single request. Keep it alive for a
        // bounded drain after posting (including a drag's cleanup mouse-up),
        // without retrying input or claiming the target handled the event.
        defer { PostedInputDrain.wait() }
        switch payload.action.op {
        case "click":
            try postMouseClick(at: points[0])
        case "drag":
            try postMouseDrag(from: points[0], to: points[1])
        case "scroll":
            try postVisualScroll(
                at: points[0],
                direction: payload.action.direction ?? "",
                amount: payload.action.amount ?? .page
            )
        default:
            break
        }

        return ActionResult(
            status: "unknown",
            reason: "visual action was dispatched; visible outcome requires re-observation",
            accepted: true,
            post: nil
        )
    } catch let failure as HelperFailure {
        return ActionResult(
            status: preflightFailureStatus(failure),
            reason: "\(failure.code): \(failure.message)",
            accepted: false,
            post: nil
        )
    } catch let failure as VisualCaptureFailure {
        return ActionResult(
            status: preflightFailureStatus(HelperFailure(code: failure.code, message: failure.message)),
            reason: "\(failure.code): \(failure.message)",
            accepted: false,
            post: nil
        )
    } catch {
        return ActionResult(
            status: "failed",
            reason: "visual action failed: \(error)",
            accepted: false,
            post: nil
        )
    }
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
    try requireInteractiveSession()
    guard AXIsProcessTrusted() else {
        throw HelperFailure(code: "accessibility_permission_required", message: accessibilityPermissionMessage())
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
    let normalized = RiskPolicy.normalizedKey(key)
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

/// Scroll dispatch strategy (WP13). Preference order from the contract:
///   (a) AX-native: adjust the containing AXScrollArea's vertical scroll bar
///       AXValue — focus-safe, deterministic, and the only path that targets
///       the bound window without moving the pointer.
///   (b) Scroll-wheel CGEvent: REJECTED. A scroll-wheel event is routed by the
///       pointer's screen position and cannot be bound to a specific window
///       without raising/focusing it or hijacking the global pointer, both of
///       which this driver forbids. (a) is implemented because it genuinely
///       works for every AppKit AXScrollArea (NSScrollView/NSTableView).

/// The scrollable container that contains (or is) the referenced element.
/// Walks the Accessibility parent chain up to the observed window; anything
/// further up (the application, other windows) is out of scope.
private func scrollableContainer(_ element: AXUIElement, window: AXUIElement) -> AXUIElement? {
    var current: AXUIElement? = element
    for _ in 0..<16 {
        guard let node = current else { return nil }
        if stringAttribute(node, kAXRoleAttribute as CFString) == "AXScrollArea" { return node }
        if CFHash(node) == CFHash(window) { return nil }
        current = elementAttribute(node, kAXParentAttribute as CFString)
    }
    return nil
}

/// The vertical scroll bar of an AXScrollArea, chosen by explicit orientation
/// and falling back to the sole scroll bar when orientation is unavailable.
private func verticalScrollBar(_ scrollArea: AXUIElement) -> AXUIElement? {
    let bars = elementArrayAttribute(scrollArea, kAXChildrenAttribute as CFString)
        .filter { stringAttribute($0, kAXRoleAttribute as CFString) == "AXScrollBar" }
    if let vertical = bars.first(where: {
        stringAttribute($0, "AXOrientation" as CFString) == "AXVerticalOrientation"
    }) { return vertical }
    return bars.count == 1 ? bars[0] : nil
}

private let lineScrollPoints = 40.0

/// Compute the next vertical scroll bar value for the requested direction and
/// amount. The scroller value is normalized to its own min...max range; a page
/// maps to one viewport height and a point amount maps through the measured
/// content-minus-viewport overflow. This is focus-safe and deterministic: it
/// adjusts the scroll area's own scroll bar, never the pointer.
private func scrolledValue(
    scrollArea: AXUIElement,
    scrollBar: AXUIElement,
    direction: String,
    amount: ScrollAmount?
) throws -> Double {
    let current = doubleAttribute(scrollBar, kAXValueAttribute as CFString) ?? 0
    let minValue = doubleAttribute(scrollBar, kAXMinValueAttribute as CFString) ?? 0
    let maxValue = doubleAttribute(scrollBar, kAXMaxValueAttribute as CFString) ?? 1
    guard maxValue > minValue else {
        throw HelperFailure(code: "scroll_bounds_unavailable", message: "vertical scroll bar exposes no usable value range")
    }
    guard let viewportHeight = sizeAttribute(scrollArea, kAXSizeAttribute as CFString)?.height, viewportHeight > 0 else {
        throw HelperFailure(code: "scroll_bounds_unavailable", message: "scroll area has no measurable viewport height")
    }
    var contentHeight = 0.0
    for child in elementArrayAttribute(scrollArea, kAXChildrenAttribute as CFString) {
        let role = stringAttribute(child, kAXRoleAttribute as CFString)
        if role == "AXScrollBar" || role == "AXValueIndicator" { continue }
        if let height = sizeAttribute(child, kAXSizeAttribute as CFString)?.height { contentHeight = max(contentHeight, height) }
    }
    guard contentHeight > viewportHeight else {
        throw HelperFailure(code: "scroll_not_scrollable", message: "scroll area content fits its viewport; nothing to scroll")
    }
    let scrollable = contentHeight - viewportHeight
    let pointDelta: Double
    switch amount ?? .page {
    case .page: pointDelta = viewportHeight
    case .line: pointDelta = lineScrollPoints
    case .points(let value): pointDelta = value
    }
    guard pointDelta.isFinite, pointDelta > 0 else {
        throw HelperFailure(code: "invalid_action", message: "scroll amount must be a positive point distance")
    }
    let valueDelta = pointDelta / scrollable * (maxValue - minValue)
    let signed = direction == "down" ? valueDelta : -valueDelta
    return min(maxValue, max(minValue, current + signed))
}

private func tryPost(expected: ExpectedTarget) -> PostObservation? {
    guard currentInteractiveSessionAvailability().interactiveSessionAvailable else { return nil }
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
    if failure.code.hasPrefix("stale_") || failure.code.hasPrefix("scroll_")
        || failure.code.hasPrefix("window_") || failure.code.hasPrefix("invalid_capture_")
        || failure.code == "accessibility_permission_required"
        || failure.code == "session_locked"
        || failure.code == "unsupported_key" || failure.code == "invalid_modifier"
        || failure.code == "focus_not_supported" || failure.code == "value_not_settable"
        || failure.code == "invalid_action"
        || failure.code == "window_number_required"
        || failure.code == "invalid_visual_point" || failure.code == "invalid_visual_action"
        || failure.code == "screen_recording_permission_required"
        || failure.code == "capture_unusable" {
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
        if let rejection = RiskPolicy.rejection(action: action, target: before, approval: request.approval) {
            return ActionResult(status: "rejected", reason: rejection, accepted: false, post: nil)
        }
        // Validate every fallible prerequisite before the first AX/CG mutation.
        // Once mutation begins, every later error is an ambiguous outcome.
        var preparedKey: PreparedKey?
        var preparedScroll: (scrollBar: AXUIElement, value: Double)?
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
        case "scroll":
            guard let direction = action.direction, direction == "up" || direction == "down" else {
                throw HelperFailure(code: "invalid_action", message: "scroll direction must be up or down")
            }
            guard let scrollArea = scrollableContainer(element, window: resolved.windowElement) else {
                throw HelperFailure(code: "scroll_area_not_found", message: "referenced element is not inside an Accessibility scroll area")
            }
            guard let scrollBar = verticalScrollBar(scrollArea) else {
                throw HelperFailure(code: "scroll_not_supported", message: "scroll area exposes no vertical scroll bar")
            }
            guard isSettable(scrollBar, kAXValueAttribute as CFString) else {
                throw HelperFailure(code: "scroll_not_supported", message: "vertical scroll bar value is not settable")
            }
            preparedScroll = (
                scrollBar,
                try scrolledValue(scrollArea: scrollArea, scrollBar: scrollBar, direction: direction, amount: action.amount)
            )
        default:
            throw HelperFailure(code: "invalid_action", message: "unsupported action: \(action.kind)")
        }

        // This is intentionally after all fallible validation but before the
        // first AX/CG mutation, narrowing the lock-transition race window.
        try requireInteractiveSession()

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
            // Focus is itself a mutation. If the session locks before the text
            // write, stop here and let the existing mutationStarted catch path
            // report an accepted-but-unknown outcome without exposing content.
            try requireInteractiveSession()
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
            // Re-check after an optional focus mutation and immediately before
            // dispatch. If focus already changed, a lock transition is reported
            // as unknown and no key event is posted.
            try requireInteractiveSession()
            mutationStarted = true
            preparedKey.down.postToPid(resolved.appIdentity.pid)
            preparedKey.up.postToPid(resolved.appIdentity.pid)
        case "scroll":
            guard let preparedScroll else {
                throw HelperFailure(code: "scroll_not_supported", message: "prepared scroll value disappeared")
            }
            mutationStarted = true
            let scrollCode = AXUIElementSetAttributeValue(
                preparedScroll.scrollBar,
                kAXValueAttribute as CFString,
                preparedScroll.value as CFNumber
            )
            guard scrollCode == .success else {
                return unknownAfterMutation(
                    expected: expected,
                    reason: "scroll value was attempted but returned code \(scrollCode.rawValue); visible movement is unknown"
                )
            }
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
        case "scroll":
            return ActionResult(
                status: "unknown",
                reason: "scroll was dispatched; content movement is decided by re-observation",
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

private let maxListedApps = 64
private let maxListedWindowsPerApp = 16

/// The Accessibility windows computer_observe can select, numbered the same
/// way observe numbers them. Without Accessibility trust nothing is listed:
/// the window server alone also reports menu-bar strips and other layer-0
/// windows that observe would reject.
private func accessibilityWindows(_ running: NSRunningApplication) -> [RunningAppWindow] {
    guard AXIsProcessTrusted() else { return [] }
    return windows(AXUIElementCreateApplication(running.processIdentifier)).compactMap { window in
        let identity = windowIdentity(window)
        guard let number = identity.number, let frame = identity.frame else { return nil }
        return RunningAppWindow(number: number, title: identity.title, frame: frame)
    }
}

private func runningApp(_ running: NSRunningApplication) throws -> (app: RunningApp, windowsTruncated: Bool) {
    let identity = try appIdentity(running)
    let candidates = accessibilityWindows(running)
    return (
        RunningApp(
            bundleId: identity.bundleId, pid: identity.pid, launchIdentity: identity.launchIdentity,
            name: identity.name, active: running.isActive,
            windows: Array(candidates.prefix(maxListedWindowsPerApp))
        ),
        candidates.count > maxListedWindowsPerApp
    )
}

/// Dock-visible applications only: agents, daemons and this helper are not
/// targets a model should pick from.
private func listApps() -> AppsResult {
    let regular = NSWorkspace.shared.runningApplications.filter {
        $0.activationPolicy == .regular && !$0.isTerminated && $0.bundleIdentifier?.isEmpty == false
    }
    var apps: [RunningApp] = []
    var truncated = regular.count > maxListedApps
    for running in regular.prefix(maxListedApps) {
        guard let entry = try? runningApp(running) else { continue }
        apps.append(entry.app)
        truncated = truncated || entry.windowsTruncated
    }
    return AppsResult(apps: apps, truncated: truncated, accessibilityTrusted: AXIsProcessTrusted())
}

/// Opens an installed app by exact bundle id through LaunchServices with no
/// arguments, documents or URLs, or activates the running instance.
private func launchApp(_ request: Request) async throws -> LaunchResult {
    guard let bundleId = request.launch?.bundleId,
          bundleId.range(of: #"^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$"#, options: .regularExpression) != nil,
          bundleId.contains(".") else {
        throw HelperFailure(code: "invalid_request", message: "launch requires an exact reverse-DNS bundle id")
    }
    guard bundleId != Bundle.main.bundleIdentifier else {
        throw HelperFailure(code: "invalid_request", message: "the helper cannot launch itself")
    }
    let existing = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).filter { !$0.isTerminated }
    if existing.count > 1 {
        throw HelperFailure(code: "ambiguous_application", message: "\(existing.count) instances of \(bundleId) are running; select one by pid")
    }
    var launched = false
    var running: NSRunningApplication
    if let only = existing.first {
        only.activate()
        running = only
    } else {
        running = try await openInstalledApplication(bundleId)
        launched = true
    }
    // A cold launch takes a moment to put up its first window; observing
    // before then would only report window_not_found. An instance that was
    // still quitting when we found it is replaced by a fresh launch.
    let deadline = Date().addingTimeInterval(5)
    while Date() < deadline {
        if running.isTerminated || running.bundleIdentifier == nil {
            guard !launched else { break }
            running = try await openInstalledApplication(bundleId)
            launched = true
            continue
        }
        if !AXIsProcessTrusted() || !accessibilityWindows(running).isEmpty { break }
        try? await Task.sleep(nanoseconds: 100_000_000)
    }
    return LaunchResult(launched: launched, app: try runningApp(running).app)
}

private func openInstalledApplication(_ bundleId: String) async throws -> NSRunningApplication {
    guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
        throw HelperFailure(code: "application_not_installed", message: "no installed application has bundle id \(bundleId)")
    }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    configuration.arguments = []
    configuration.promptsUserIfNeeded = false
    do {
        return try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
    } catch {
        throw HelperFailure(code: "launch_failed", message: "could not open \(bundleId): \(error.localizedDescription)")
    }
}

private func handle(_ line: String) async {
    let decoder = JSONDecoder()
    let request: Request
    do {
        request = try decoder.decode(Request.self, from: Data(line.utf8))
    } catch {
        emit(Response<EmptyResult>(
            id: "unknown", ok: false, result: nil,
            error: ErrorPayload(code: "invalid_request", message: "request is not valid for the native protocol")
        ))
        return
    }

    switch request.command {
    case "status":
        emit(Response(
            id: request.id, ok: true,
            result: makeStatus(), error: nil
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
    case "capture":
        do {
            emit(Response(id: request.id, ok: true, result: try await capture(request), error: nil))
        } catch let failure as HelperFailure {
            emit(Response<CaptureResult>(
                id: request.id, ok: false, result: nil,
                error: ErrorPayload(code: failure.code, message: failure.message)
            ))
        } catch let failure as VisualCaptureFailure {
            emit(Response<CaptureResult>(
                id: request.id, ok: false, result: nil,
                error: ErrorPayload(code: failure.code, message: failure.message)
            ))
        } catch {
            emit(Response<CaptureResult>(
                id: request.id, ok: false, result: nil,
                error: ErrorPayload(code: "capture_failed", message: String(describing: error))
            ))
        }
    case "apps":
        emit(Response(id: request.id, ok: true, result: listApps(), error: nil))
    case "launch":
        do {
            emit(Response(id: request.id, ok: true, result: try await launchApp(request), error: nil))
        } catch let failure as HelperFailure {
            emit(Response<LaunchResult>(
                id: request.id, ok: false, result: nil,
                error: ErrorPayload(code: failure.code, message: failure.message)
            ))
        } catch {
            emit(Response<LaunchResult>(
                id: request.id, ok: false, result: nil,
                error: ErrorPayload(code: "launch_failed", message: String(describing: error))
            ))
        }
    case "act":
        emit(Response(id: request.id, ok: true, result: actionResult(request), error: nil))
    case "visual-act":
        emit(Response(id: request.id, ok: true, result: await visualActionResult(request), error: nil))
    default:
        emit(Response<EmptyResult>(
            id: request.id, ok: false, result: nil,
            error: ErrorPayload(code: "unknown_command", message: "unsupported command: \(request.command)")
        ))
    }
}

while let line = readLine() {
    if !line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { await handle(line) }
}
