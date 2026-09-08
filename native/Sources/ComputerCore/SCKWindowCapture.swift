import CoreGraphics
import Foundation
import ScreenCaptureKit

/// Errors returned by the ScreenCaptureKit one-shot capture path.
public enum SCKCaptureError: Error, Equatable, Sendable {
    case invalidWindowID
    case invalidOwnerPID
    case invalidExpectedFrame
    case permissionDenied
    case contentUnavailable(String)
    case windowNotFound
    case windowAmbiguous(count: Int)
    case windowIDMismatch(actual: CGWindowID)
    case windowOwnerMismatch(actual: Int32)
    case windowBoundsMismatch(expected: CGRect, actual: CGRect)
    case unsafePixelDimensions(width: Int, height: Int)
    case returnedDimensionMismatch(expectedWidth: Int, expectedHeight: Int, actualWidth: Int, actualHeight: Int)
    case timedOut(seconds: TimeInterval)
    case captureFailed(String)

    public var debugDescription: String {
        switch self {
        case .invalidWindowID:
            return "SCK capture requires a non-zero 32-bit CGWindowID"
        case .invalidOwnerPID:
            return "SCK capture requires a positive owning process ID"
        case .invalidExpectedFrame:
            return "SCK capture requires a finite, non-empty expected CGRect"
        case .permissionDenied:
            return "Screen Recording permission is not granted to this process"
        case .contentUnavailable(let message):
            return "SCShareableContent unavailable: \(message)"
        case .windowNotFound:
            return "No owned ScreenCaptureKit window matched the exact windowID/ownerPID"
        case .windowAmbiguous(let count):
            return "Multiple owned ScreenCaptureKit windows matched the exact identity (count=\(count))"
        case .windowIDMismatch(let actual):
            return "WindowID changed (actual=\(actual))"
        case .windowOwnerMismatch(let actual):
            return "Window owner PID changed (actual=\(actual))"
        case .windowBoundsMismatch(let expected, let actual):
            return "Window bounds changed expected=\(expected) actual=\(actual)"
        case .unsafePixelDimensions(let width, let height):
            return "Refusing unsafe capture dimensions \(width)x\(height)"
        case .returnedDimensionMismatch(let expectedWidth, let expectedHeight, let actualWidth, let actualHeight):
            return "Captured image dimensions \(actualWidth)x\(actualHeight) did not match requested \(expectedWidth)x\(expectedHeight)"
        case .timedOut(let seconds):
            return "ScreenCaptureKit capture did not complete within \(seconds) seconds"
        case .captureFailed(let message):
            return "ScreenCaptureKit capture failed: \(message)"
        }
    }
}

/// Bounded execution for APIs that may not observe cancellation promptly.
///
/// This is deliberately not implemented with `withThrowingTaskGroup`. A task
/// group is structured: when the timeout path throws, the group still waits for
/// sibling child tasks to finish before the caller resumes, so a non-cooperative
/// screenshot task can defeat the deadline.
///
/// Instead, the work runs in an unstructured task and a deadline task writes to
/// an `AsyncThrowingStream`. The caller resumes as soon as either the first
/// value/error or the deadline arrives; it does **not** wait for the abandoned
/// work task. On timeout the work task is cancelled (cooperative cleanup only);
/// if it ignores cancellation it may outlive this API call, but the caller is
/// never blocked past the deadline. No semaphore or main-runloop pumping is used.
enum BoundedAsyncTimeout {
    static func run<Success: Sendable>(
        timeout: TimeInterval,
        operation: @escaping @Sendable () async throws -> Success
    ) async throws -> Success {
        guard timeout.isFinite, timeout > 0 else {
            throw SCKCaptureError.timedOut(seconds: timeout)
        }

        let workTask = Task { try await operation() }
        defer { workTask.cancel() }

        let stream = AsyncThrowingStream<Success, Error> { continuation in
            Task {
                do {
                    let value = try await workTask.value
                    continuation.yield(value)
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            Task {
                do {
                    try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                    continuation.finish(throwing: SCKCaptureError.timedOut(seconds: timeout))
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }

        do {
            for try await value in stream {
                return value
            }
        } catch {
            throw error
        }
        throw SCKCaptureError.timedOut(seconds: timeout)
    }
}

/// Minimal, dependency-light one-shot ScreenCaptureKit window capture.
///
/// This module deliberately keeps the original `CGImage` returned by
/// `SCScreenshotManager.captureImage(contentFilter:configuration:)` unmodified so
/// the downstream exact-hash pipeline sees the same BGRA provider bytes/stride that
/// were proven byte-stable for the owned fixture window.
///
/// - Note: `SCScreenshotManager` requires macOS 14.0+. If the target runs on an
///   earlier supported version (macOS 13), the synchronous CGWindow list fallback
///   remains owned by `WindowCaptureEngine`; this file never falls back.
@available(macOS 14.0, *)
public enum SCKWindowCapture {
    /// Upper bound for either pixel dimension; keeps row/region math far away from
    /// any Int overflow while still supporting very large displays.
    private static let maximumPixelSide = 32_768
    /// Point-frame tolerance used to confirm the window did not move/resize between
    /// the caller's metadata and SCK's report. Matches the existing CG module (2 pt).
    private static let boundsTolerance = 2.0

    /// One-shot capture of an exact owned window.
    ///
    /// - Parameters:
    ///   - windowID: Exact `CGWindowID` (SCWindow.windowID) to capture.
    ///   - ownerPID: The owning application's process ID; must match
    ///     `SCWindow.owningApplication.processID`.
    ///   - expectedFrame: The window's global frame (points) in a Y-down CoordinateSpace
    ///     as previously seen by the caller. Used only to validate identity, never to
    ///     crop or request a different region.
    ///   - timeout: Bounded overall wait before giving up.
    /// - Returns: The untouched BGRA `CGImage` (window-only, no cursor/shadow, opaque,
    ///   best-resolution capture) ready for the existing exact-hash path.
    public static func capture(
        windowID: CGWindowID,
        ownerPID: Int32,
        expectedFrame: CGRect,
        timeout: TimeInterval
    ) async throws -> CGImage {
        try await BoundedAsyncTimeout.run(timeout: timeout) {
            try await performCapture(
                windowID: windowID,
                ownerPID: ownerPID,
                expectedFrame: expectedFrame
            )
        }
    }

    private static func performCapture(
        windowID: CGWindowID,
        ownerPID: Int32,
        expectedFrame: CGRect
    ) async throws -> CGImage {
        try validate(windowID: windowID, ownerPID: ownerPID, expectedFrame: expectedFrame)

        guard CGPreflightScreenCaptureAccess() else {
            throw SCKCaptureError.permissionDenied
        }

        let content: SCShareableContent
        do {
            content = try await SCShareableContent.current
        } catch {
            throw SCKCaptureError.contentUnavailable(String(describing: error))
        }

        let exact = content.windows.filter { window in
            window.windowID == windowID
                && window.owningApplication?.processID == ownerPID
                && window.isOnScreen
        }
        guard let window = exact.first else {
            // Distinguish "vanished" vs "moved owner" for diagnosability. The owner
            // PID is authoritative, so a stale ID/PID never silently captures another window.
            let sameOwner = content.windows.contains {
                $0.owningApplication?.processID == ownerPID && $0.isOnScreen
            }
            if sameOwner {
                throw SCKCaptureError.windowIDMismatch(actual: windowID)
            }
            throw SCKCaptureError.windowNotFound
        }
        guard exact.count == 1 else {
            throw SCKCaptureError.windowAmbiguous(count: exact.count)
        }
        guard window.owningApplication?.processID == ownerPID else {
            throw SCKCaptureError.windowOwnerMismatch(actual: window.owningApplication?.processID ?? -1)
        }
        guard frameApproximatelyEquals(window.frame, expectedFrame, tolerance: boundsTolerance) else {
            throw SCKCaptureError.windowBoundsMismatch(expected: expectedFrame, actual: window.frame)
        }

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let info = SCShareableContent.info(for: filter)
        guard info.pointPixelScale.isFinite, info.pointPixelScale > 0,
              info.contentRect.width.isFinite, info.contentRect.height.isFinite,
              info.contentRect.width > 0, info.contentRect.height > 0 else {
            throw SCKCaptureError.windowBoundsMismatch(
                expected: expectedFrame,
                actual: CGRect(x: info.contentRect.origin.x,
                               y: info.contentRect.origin.y,
                               width: info.contentRect.width,
                               height: info.contentRect.height)
            )
        }

        let renderScale = Double(info.pointPixelScale)
        let renderWidth = max(1, Int((info.contentRect.width * renderScale).rounded()))
        let renderHeight = max(1, Int((info.contentRect.height * renderScale).rounded()))
        try validatePixelDimensions(width: renderWidth, height: renderHeight)

        let configuration = SCStreamConfiguration()
        configuration.width = renderWidth
        configuration.height = renderHeight
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.showsCursor = false
        configuration.ignoreGlobalClipSingleWindow = true
        configuration.ignoreShadowsSingleWindow = true
        configuration.shouldBeOpaque = true
        configuration.captureResolution = .best

        let image: CGImage
        do {
            image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        } catch {
            throw SCKCaptureError.captureFailed(String(describing: error))
        }

        guard image.width == renderWidth, image.height == renderHeight else {
            throw SCKCaptureError.returnedDimensionMismatch(
                expectedWidth: renderWidth,
                expectedHeight: renderHeight,
                actualWidth: image.width,
                actualHeight: image.height
            )
        }
        try validatePixelDimensions(width: image.width, height: image.height)
        return image
    }

    static func validate(
        windowID: CGWindowID,
        ownerPID: Int32,
        expectedFrame: CGRect
    ) throws {
        guard windowID != 0 else {
            throw SCKCaptureError.invalidWindowID
        }
        guard ownerPID > 0 else {
            throw SCKCaptureError.invalidOwnerPID
        }
        guard expectedFrame.isFiniteNonEmpty else {
            throw SCKCaptureError.invalidExpectedFrame
        }
    }

    static func validatePixelDimensions(width: Int, height: Int) throws {
        guard width > 0, height > 0,
              width <= maximumPixelSide, height <= maximumPixelSide,
              width <= Int(Int32.max) / 4,
              height <= Int(Int32.max) / 4 else {
            throw SCKCaptureError.unsafePixelDimensions(width: width, height: height)
        }
    }

    private static func frameApproximatelyEquals(
        _ lhs: CGRect,
        _ rhs: CGRect,
        tolerance: CGFloat
    ) -> Bool {
        abs(lhs.minX - rhs.minX) <= tolerance
            && abs(lhs.minY - rhs.minY) <= tolerance
            && abs(lhs.width - rhs.width) <= tolerance
            && abs(lhs.height - rhs.height) <= tolerance
    }
}

extension CGRect {
    fileprivate var isFiniteNonEmpty: Bool {
        origin.x.isFinite && origin.y.isFinite
            && width.isFinite && height.isFinite
            && width > 0 && height > 0
    }
}
