import Foundation

/// Prompt-free signals describing whether the caller still owns an interactive
/// macOS console session. Optional values are intentional: an unavailable
/// signal must never be treated as proof that Computer Use is safe to run.
public struct InteractiveSessionSignals: Equatable, Sendable {
    public let frontmostBundleIdentifier: String?
    public let loginDone: Bool?
    public let onConsole: Bool?
    public let screenLocked: Bool?

    public init(
        frontmostBundleIdentifier: String?,
        loginDone: Bool?,
        onConsole: Bool?,
        screenLocked: Bool?
    ) {
        self.frontmostBundleIdentifier = frontmostBundleIdentifier
        self.loginDone = loginDone
        self.onConsole = onConsole
        self.screenLocked = screenLocked
    }
}

public struct InteractiveSessionAvailability: Equatable, Sendable {
    /// Positive evidence that the console is locked or not the active session.
    public let sessionLocked: Bool
    /// False includes both a known lock and indeterminate/unavailable signals.
    public let interactiveSessionAvailable: Bool

    public init(sessionLocked: Bool, interactiveSessionAvailable: Bool) {
        self.sessionLocked = sessionLocked
        self.interactiveSessionAvailable = interactiveSessionAvailable
    }
}

public enum InteractiveSessionPolicy {
    public static let loginWindowBundleIdentifier = "com.apple.loginwindow"

    /// The policy is deliberately fail-closed for the three stable public
    /// signals. WindowServer omits `CGSSessionScreenIsLocked` when unlocked on
    /// current macOS, so absence of that optional negative signal is accepted
    /// only when frontmost/loginDone/onConsole all positively identify an
    /// interactive desktop. Other missing state remains unavailable.
    public static func evaluate(_ signals: InteractiveSessionSignals) -> InteractiveSessionAvailability {
        let frontmostIsLoginWindow = signals.frontmostBundleIdentifier == loginWindowBundleIdentifier
        let locked = signals.screenLocked == true
            || frontmostIsLoginWindow
            || signals.loginDone == false
            || signals.onConsole == false
        let interactive = signals.screenLocked != true
            && signals.frontmostBundleIdentifier != nil
            && signals.frontmostBundleIdentifier != loginWindowBundleIdentifier
            && signals.loginDone == true
            && signals.onConsole == true
        return InteractiveSessionAvailability(
            sessionLocked: locked,
            interactiveSessionAvailable: interactive
        )
    }
}
