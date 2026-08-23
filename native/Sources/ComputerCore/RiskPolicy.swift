import Foundation

public enum RiskPolicy {
    private static let highRiskTerms = [
        "delete", "erase", "remove", "uninstall", "destroy", "wipe",
        "pay", "purchase", "buy now", "checkout", "transfer", "wire", "send money", "place order",
        "send", "publish", "post", "submit", "share",
        "删除", "清除", "抹掉", "卸载", "销毁", "付款", "支付", "购买", "下单", "转账", "汇款", "发送", "发布", "提交", "分享",
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

    public static func rejection(action: ActionPayload, target: ElementIdentity) -> String? {
        if action.kind == "type" && target.secure {
            return "secure text entry is blocked"
        }

        if action.kind == "key", let key = action.key {
            let normalizedKey = key.trimmingCharacters(in: .whitespaces).lowercased()
            if commitKeys.contains(normalizedKey) {
                return "commit key is blocked until a host-owned approval flow exists: \(normalizedKey.isEmpty ? "newline" : normalizedKey)"
            }
            let modifiers = Array(Set(action.modifiers ?? [])).sorted()
            let chord = (modifiers + [normalizedKey]).joined(separator: "+")
            if !safeKeyChords.contains(chord) {
                return "key chord is outside the explicit safe navigation allowlist: \(chord)"
            }
        }

        if action.kind == "click" || action.kind == "key" {
            let semantics = [target.name, target.identifier, Optional(target.role), target.subrole]
                .compactMap { $0 }
                .joined(separator: " ")
                .folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: .current)
                .lowercased()
            if let term = highRiskTerms.first(where: { semantics.contains($0) }) {
                return "high-risk target semantics are blocked: \(term)"
            }
        }
        return nil
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
