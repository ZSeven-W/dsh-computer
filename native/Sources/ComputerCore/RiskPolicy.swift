import CryptoKit
import Foundation

public enum ActionRiskCode: String, Codable, Equatable, Sendable {
    case secureText = "secure-text"
    case dangerousClick = "dangerous-click"
    case commitKey = "commit-key"
    case unsafeKeyChord = "unsafe-key-chord"
    case visualPointAction = "visual-point-action"
}

public enum ActionRiskDecision: Equatable, Sendable {
    case safe
    case hardDeny(code: ActionRiskCode, reason: String)
    case approvalRequired(code: ActionRiskCode, reason: String)

    public var code: ActionRiskCode? {
        switch self {
        case .safe: nil
        case let .hardDeny(code, _), let .approvalRequired(code, _): code
        }
    }
}

private struct ApprovalCodingKey: CodingKey, Hashable {
    let stringValue: String
    let intValue: Int? = nil

    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
}

/// A host-minted, one-action approval binding. The Helper deliberately accepts
/// this only at the top request level; it is not part of ActionPayload and is
/// therefore never model-controlled action input.
public struct HostApprovalGrant: Decodable, Equatable, Sendable {
    public let outcome: String
    public let observationId: String
    public let observationFingerprint: String
    public let riskCode: ActionRiskCode
    public let actionDigest: String
    public let nonce: String
    public let refDigest: String

    private static let fieldNames: Set<String> = [
        "outcome", "observationId", "observationFingerprint", "riskCode",
        "actionDigest", "nonce", "refDigest",
    ]

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: ApprovalCodingKey.self)
        guard Set(container.allKeys.map(\.stringValue)) == Self.fieldNames else {
            throw Self.invalid(decoder, "approval fields are invalid")
        }

        func string(_ name: String) throws -> String {
            guard let key = ApprovalCodingKey(stringValue: name) else {
                throw Self.invalid(decoder, "approval fields are invalid")
            }
            return try container.decode(String.self, forKey: key)
        }

        let outcome = try string("outcome")
        let observationId = try string("observationId")
        let observationFingerprint = try string("observationFingerprint")
        let rawRiskCode = try string("riskCode")
        let actionDigest = try string("actionDigest")
        let nonce = try string("nonce")
        let refDigest = try string("refDigest")

        guard outcome == "allowed-once" else {
            throw Self.invalid(decoder, "approval outcome is invalid")
        }
        guard observationId.range(
            of: #"^obs_[A-Za-z0-9_-]{1,124}$"#,
            options: .regularExpression
        ) != nil else {
            throw Self.invalid(decoder, "approval observation binding is invalid")
        }
        guard Self.isLowercaseSHA256(observationFingerprint),
              Self.isLowercaseSHA256(actionDigest),
              Self.isLowercaseSHA256(refDigest) else {
            throw Self.invalid(decoder, "approval digest binding is invalid")
        }
        guard nonce.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil else {
            throw Self.invalid(decoder, "approval nonce is invalid")
        }
        guard let riskCode = ActionRiskCode(rawValue: rawRiskCode), riskCode != .secureText else {
            throw Self.invalid(decoder, "approval risk binding is invalid")
        }

        self.outcome = outcome
        self.observationId = observationId
        self.observationFingerprint = observationFingerprint
        self.riskCode = riskCode
        self.actionDigest = actionDigest
        self.nonce = nonce
        self.refDigest = refDigest
    }

    private static func invalid(_ decoder: Decoder, _ description: String) -> DecodingError {
        .dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: description))
    }

    private static func isLowercaseSHA256(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy {
            ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102)
        }
    }
}

public enum ActionApprovalBinding {
    private static let version = "dsh-computer-action-v1"
    private static let allowedModifiers: Set<String> = ["command", "control", "fn", "option", "shift"]

    /// SHA-256 over a length-prefixed UTF-8 canonical form shared with the TS
    /// controller. Exact type text is retained; only key aliases/modifiers are
    /// normalized because the native dispatch does the same normalization.
    public static func digest(action: ActionPayload) -> String? {
        let components: [String]
        switch action.kind {
        case "click", "focus":
            components = [version, action.kind]
        case "type":
            guard let text = action.text else { return nil }
            components = [version, "type", text]
        case "key":
            guard let key = action.key else { return nil }
            let modifiers = Array(Set(action.modifiers ?? [])).sorted()
            guard modifiers.allSatisfy(allowedModifiers.contains) else { return nil }
            components = [version, "key", RiskPolicy.normalizedKey(key)] + modifiers
        default:
            return nil
        }
        let canonical = components.map { "\($0.utf8.count):\($0)" }.joined(separator: "|")
        return SHA256.hash(data: Data(canonical.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

public enum RiskPolicy {
    private static let highRiskPatterns: [(category: String, pattern: String)] = [
        ("destructive", #"\b(delete|erase|remove|uninstall|destroy|wipe)\b|删除|抹掉|卸载|销毁"#),
        ("financial", #"\b(pay|purchase|buy now|checkout|transfer|wire|send money|place order)\b|付款|支付|购买|下单|转账|汇款"#),
        ("external-commit", #"\b(send|publish|post|submit|share)\b|发送|发布|提交|分享"#),
    ]

    private static let commitKeys: Set<String> = ["return", "enter", "numpadenter", "\n", "\r", "↩"]

    private static let safeKeyChords: Set<String> = [
        "tab", "shift+tab", "escape",
        "left", "right", "up", "down",
        "shift+left", "shift+right", "shift+up", "shift+down",
        "option+left", "option+right", "option+shift+left", "option+shift+right",
        "home", "end", "pageup", "pagedown",
        "shift+home", "shift+end", "shift+pageup", "shift+pagedown",
    ]

    // Mirrors KEY_ALIASES in src/policy.ts; the approval digest depends on it.
    private static let keyAliases: [String: String] = [
        "esc": "escape",
        "arrowleft": "left", "arrowright": "right", "arrowup": "up", "arrowdown": "down",
    ]

    public static func normalizedKey(_ key: String) -> String {
        let normalized = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if key == "\n" || key == "\r" || normalized == "↩" || normalized == "numpadenter" || normalized == "enter" {
            return "return"
        }
        return keyAliases[normalized] ?? normalized
    }

    public static func classify(action: ActionPayload, target: ElementIdentity) -> ActionRiskDecision {
        if action.kind == "type" && target.secure {
            return .hardDeny(code: .secureText, reason: "secure text entry is permanently blocked")
        }

        if action.kind == "key", let key = action.key {
            let normalizedKeyValue = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if commitKeys.contains(normalizedKeyValue) || key == "\n" || key == "\r" {
                return .approvalRequired(
                    code: .commitKey,
                    reason: "commit key requires one-action host approval"
                )
            }
            let modifiers = Array(Set(action.modifiers ?? [])).sorted()
            let chord = (modifiers + [normalizedKey(key)]).joined(separator: "+")
            if !safeKeyChords.contains(chord) {
                return .approvalRequired(
                    code: .unsafeKeyChord,
                    reason: "key chord outside the safe navigation allowlist requires one-action host approval"
                )
            }
        }

        if action.kind == "click" {
            let semantics = [target.name, target.identifier, Optional(target.role), target.subrole]
                .compactMap { $0 }
                .joined(separator: " ")
                .precomposedStringWithCompatibilityMapping
            if let match = highRiskPatterns.first(where: {
                semantics.range(of: $0.pattern, options: [.regularExpression, .caseInsensitive]) != nil
            }) {
                return .approvalRequired(
                    code: .dangerousClick,
                    reason: "target semantics indicate a \(match.category) operation and require one-action host approval"
                )
            }
        }
        return .safe
    }

    /// Backward-compatible deny/ask summary for callers that do not yet
    /// distinguish a permanent block from a host-approvable action.
    public static func rejection(action: ActionPayload, target: ElementIdentity) -> String? {
        switch classify(action: action, target: target) {
        case .safe: nil
        case let .hardDeny(_, reason), let .approvalRequired(_, reason): reason
        }
    }

    /// Enforce the native half of the host approval contract. The fingerprint
    /// and ref digests are format-validated during decode; the Helper cannot
    /// recompute them because opaque scope/ref material never crosses this
    /// boundary. Risk code and action digest are recomputed here.
    public static func rejection(
        action: ActionPayload,
        target: ElementIdentity,
        approval: HostApprovalGrant?
    ) -> String? {
        switch classify(action: action, target: target) {
        case .safe:
            return approval == nil ? nil : "host approval grant is not applicable to this action"
        case let .hardDeny(_, reason):
            return reason
        case let .approvalRequired(code, reason):
            guard let approval else { return reason }
            guard approval.riskCode == code,
                  let digest = ActionApprovalBinding.digest(action: action),
                  approval.actionDigest == digest else {
                return "host approval grant does not match this action"
            }
            return nil
        }
    }
}

/// Confirmation is deliberately narrower than dispatch success. Missing or
/// rebound post-state is never proof. Clicks confirm only a value transition
/// on the same live target (checkboxes/switches); buttons normally stay unknown.
public enum ActionConfirmation {
    public static func isConfirmed(
        action: ActionPayload,
        before: ElementIdentity,
        post: ElementIdentity?,
        postIdentityMatches: Bool
    ) -> Bool {
        guard postIdentityMatches, let post else { return false }
        switch action.kind {
        case "focus":
            return post.focused == true
        case "type":
            return action.text != nil && post.value == action.text
        case "click":
            return before.value != post.value
        default:
            return false
        }
    }
}
