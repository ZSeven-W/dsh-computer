import Foundation

/// The non-image metadata needed to bind an Accessibility window to the
/// corresponding Window Server record. CoreGraphics records are adapted to
/// this value in the helper so the matching policy stays deterministic and
/// independently testable.
public struct WindowMetadataCandidate: Equatable, Sendable {
    public let number: Int
    public let ownerPID: Int32
    public let layer: Int
    public let frame: ComputerFrame
    public let title: String?

    public init(number: Int, ownerPID: Int32, layer: Int, frame: ComputerFrame, title: String?) {
        self.number = number
        self.ownerPID = ownerPID
        self.layer = layer
        self.frame = frame
        self.title = title
    }
}

public enum WindowNumberMatcher {
    /// AX positions and Window Server bounds both use global, top-left screen
    /// coordinates. They are point-space values even on Retina displays, so no
    /// backing-scale conversion belongs in this matcher.
    public static func uniqueWindowNumber(
        ownerPID: Int32,
        accessibilityFrame: ComputerFrame?,
        accessibilityTitle: String?,
        candidates: [WindowMetadataCandidate],
        tolerance: Double = 2.0
    ) -> Int? {
        guard ownerPID > 0,
              tolerance.isFinite,
              tolerance >= 0,
              let accessibilityFrame,
              usable(accessibilityFrame) else { return nil }

        let geometryMatches = candidates.filter { candidate in
            candidate.number > 0
                && candidate.number <= Int(UInt32.max)
                && candidate.ownerPID == ownerPID
                && candidate.layer == 0
                && usable(candidate.frame)
                && accessibilityFrame.approximatelyEquals(candidate.frame, tolerance: tolerance)
        }

        if geometryMatches.count == 1, let only = geometryMatches.first {
            // A missing Window Server title is common without Screen Recording
            // access and carries no negative evidence. Two present but unequal
            // titles do contradict the otherwise unique geometry match.
            if let expected = presentTitle(accessibilityTitle),
               let actual = presentTitle(only.title),
               expected != actual { return nil }
            return only.number
        }

        guard geometryMatches.count > 1,
              let expectedTitle = presentTitle(accessibilityTitle) else { return nil }

        // Title can disambiguate geometry only when every competing record has
        // a title. An unknown title must remain an unresolved candidate.
        let titled = geometryMatches.compactMap { candidate -> WindowMetadataCandidate? in
            presentTitle(candidate.title) == nil ? nil : candidate
        }
        guard titled.count == geometryMatches.count else { return nil }
        let exactTitleMatches = titled.filter { presentTitle($0.title) == expectedTitle }
        guard exactTitleMatches.count == 1 else { return nil }
        return exactTitleMatches[0].number
    }

    private static func usable(_ frame: ComputerFrame) -> Bool {
        frame.x.isFinite
            && frame.y.isFinite
            && frame.width.isFinite
            && frame.height.isFinite
            && frame.width > 0
            && frame.height > 0
    }

    private static func presentTitle(_ title: String?) -> String? {
        guard let title,
              !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return title
    }
}
