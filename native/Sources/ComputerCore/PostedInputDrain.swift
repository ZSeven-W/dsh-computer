import Foundation

/// Keeps the one-request helper alive briefly after posting asynchronous input
/// to WindowServer. Posting is not an acknowledgement that the app handled the
/// event: callers must still return an unknown outcome and re-observe.
public enum PostedInputDrain {
    public static let duration: TimeInterval = 0.1

    public static func wait(
        sleep: (TimeInterval) -> Void = { Thread.sleep(forTimeInterval: $0) }
    ) {
        sleep(duration)
    }
}
