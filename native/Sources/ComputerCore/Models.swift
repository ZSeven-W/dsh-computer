import CryptoKit
import Foundation

public struct ComputerFrame: Codable, Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x == 0 ? 0 : x
        self.y = y == 0 ? 0 : y
        self.width = width == 0 ? 0 : width
        self.height = height == 0 ? 0 : height
    }

    public func approximatelyEquals(_ other: ComputerFrame?, tolerance: Double = 1.0) -> Bool {
        guard let other else { return false }
        return abs(x - other.x) <= tolerance
            && abs(y - other.y) <= tolerance
            && abs(width - other.width) <= tolerance
            && abs(height - other.height) <= tolerance
    }
}

public struct AppIdentity: Codable, Equatable, Sendable {
    public let bundleId: String
    public let pid: Int32
    public let launchIdentity: String?
    public let name: String?

    public init(bundleId: String, pid: Int32, launchIdentity: String?, name: String?) {
        self.bundleId = bundleId
        self.pid = pid
        self.launchIdentity = launchIdentity
        self.name = name
    }

    private enum CodingKeys: String, CodingKey {
        case bundleId, pid, launchIdentity, name
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(bundleId, forKey: .bundleId)
        try container.encode(pid, forKey: .pid)
        try container.encode(launchIdentity, forKey: .launchIdentity)
        try container.encode(name, forKey: .name)
    }
}

public struct WindowIdentity: Codable, Equatable, Sendable {
    public let number: Int?
    public let role: String
    public let subrole: String?
    public let title: String?
    public let frame: ComputerFrame?
    public let identity: String

    public init(number: Int?, role: String, subrole: String?, title: String?, frame: ComputerFrame?, identity: String) {
        self.number = number
        self.role = role
        self.subrole = subrole
        self.title = title
        self.frame = frame
        self.identity = identity
    }

    private enum CodingKeys: String, CodingKey {
        case number, role, subrole, title, frame, identity
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(number, forKey: .number)
        try container.encode(role, forKey: .role)
        try container.encode(subrole, forKey: .subrole)
        try container.encode(title, forKey: .title)
        try container.encode(frame, forKey: .frame)
        try container.encode(identity, forKey: .identity)
    }
}

public struct ElementIdentity: Codable, Equatable, Sendable {
    public let role: String
    public let subrole: String?
    public let name: String?
    public let identifier: String?
    public let frame: ComputerFrame?
    public let enabled: Bool?
    public let focused: Bool?
    public let secure: Bool
    public let actions: [String]
    public let value: String?

    public init(
        role: String,
        subrole: String?,
        name: String?,
        identifier: String?,
        frame: ComputerFrame?,
        enabled: Bool?,
        focused: Bool?,
        secure: Bool,
        actions: [String],
        value: String?
    ) {
        self.role = role
        self.subrole = subrole
        self.name = name
        self.identifier = identifier
        self.frame = frame
        self.enabled = enabled
        self.focused = focused
        self.secure = secure
        self.actions = actions
        self.value = secure ? nil : value
    }

    private enum CodingKeys: String, CodingKey {
        case role, subrole, name, identifier, frame, enabled, focused, secure, actions, value
    }

    public func encode(to encoder: Encoder) throws {
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
    }
}

public struct ActionPayload: Codable, Equatable, Sendable {
    public let kind: String
    public let text: String?
    public let key: String?
    public let modifiers: [String]?

    public init(kind: String, text: String? = nil, key: String? = nil, modifiers: [String]? = nil) {
        self.kind = kind
        self.text = text
        self.key = key
        self.modifiers = modifiers
    }
}

public enum IdentityCheck: Equatable, Sendable {
    case match
    case stale(String)
}

public enum IdentityVerifier {
    public static func app(expected: AppIdentity, live: AppIdentity) -> IdentityCheck {
        guard expected.bundleId == live.bundleId else { return .stale("application bundle identifier changed") }
        guard expected.pid == live.pid else { return .stale("application PID changed") }
        guard expected.launchIdentity != nil, expected.launchIdentity == live.launchIdentity else {
            return .stale("application launch identity is missing or changed")
        }
        return .match
    }

    public static func window(expected: WindowIdentity, live: WindowIdentity) -> IdentityCheck {
        if let number = expected.number {
            guard live.number == number else { return .stale("window number changed") }
        } else {
            guard expected.identity == live.identity else { return .stale("window identity changed") }
        }
        guard expected.role == live.role, expected.subrole == live.subrole else {
            return .stale("window role changed")
        }
        guard expected.title == live.title else { return .stale("window title changed") }
        if expected.frame == nil {
            guard live.frame == nil else { return .stale("window frame appeared") }
        } else if !expected.frame!.approximatelyEquals(live.frame) {
            return .stale("window frame changed")
        }
        return .match
    }

    public static func element(expected: ElementIdentity, live: ElementIdentity) -> IdentityCheck {
        guard expected.role == live.role, expected.subrole == live.subrole else {
            return .stale("target role changed")
        }
        guard expected.identifier == live.identifier else { return .stale("target identifier changed") }
        guard expected.name == live.name else { return .stale("target name changed") }
        if expected.frame == nil {
            guard live.frame == nil else { return .stale("target frame appeared") }
        } else if !expected.frame!.approximatelyEquals(live.frame) {
            return .stale("target frame changed")
        }
        guard expected.secure == live.secure else { return .stale("target security role changed") }
        return .match
    }
}

public func stableDigest(_ components: [String]) -> String {
    let data = Data(components.joined(separator: "\u{1f}").utf8)
    return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}
