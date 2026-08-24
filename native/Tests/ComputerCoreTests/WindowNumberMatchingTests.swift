import XCTest
@testable import ComputerCore

final class WindowNumberMatchingTests: XCTestCase {
    private let frame = ComputerFrame(x: 417, y: 203, width: 913, height: 711)

    private func candidate(
        number: Int,
        pid: Int32 = 4242,
        layer: Int = 0,
        frame: ComputerFrame? = nil,
        title: String? = "Codex"
    ) -> WindowMetadataCandidate {
        WindowMetadataCandidate(
            number: number,
            ownerPID: pid,
            layer: layer,
            frame: frame ?? self.frame,
            title: title
        )
    }

    func testUniqueOwnerLayerAndFullFrameMatchReturnsWindowNumber() {
        let number = WindowNumberMatcher.uniqueWindowNumber(
            ownerPID: 4242,
            accessibilityFrame: frame,
            accessibilityTitle: "Codex",
            candidates: [
                candidate(number: 10, pid: 9999),
                candidate(number: 11, layer: 8),
                candidate(
                    number: 12,
                    frame: ComputerFrame(x: 418.9, y: 201.1, width: 914.5, height: 709.5)
                ),
            ]
        )
        XCTAssertEqual(number, 12)
    }

    func testNoGeometryMatchReturnsNil() {
        let number = WindowNumberMatcher.uniqueWindowNumber(
            ownerPID: 4242,
            accessibilityFrame: frame,
            accessibilityTitle: "Codex",
            candidates: [
                candidate(number: 10, pid: 9999),
                candidate(number: 11, layer: 1),
                candidate(
                    number: 12,
                    frame: ComputerFrame(x: 419.1, y: 203, width: 913, height: 711)
                ),
                candidate(
                    number: 13,
                    frame: ComputerFrame(x: 417, y: 203, width: 0, height: 711)
                ),
            ]
        )
        XCTAssertNil(number)
    }

    func testDuplicateGeometryWithoutSafeTitleDisambiguationReturnsNil() {
        XCTAssertNil(WindowNumberMatcher.uniqueWindowNumber(
            ownerPID: 4242,
            accessibilityFrame: frame,
            accessibilityTitle: "Codex",
            candidates: [
                candidate(number: 20, title: "Codex"),
                candidate(number: 21, title: nil),
            ]
        ))
        XCTAssertNil(WindowNumberMatcher.uniqueWindowNumber(
            ownerPID: 4242,
            accessibilityFrame: frame,
            accessibilityTitle: nil,
            candidates: [candidate(number: 20), candidate(number: 21)]
        ))
    }

    func testExactTitleSafelyDisambiguatesFullyTitledCandidates() {
        XCTAssertEqual(WindowNumberMatcher.uniqueWindowNumber(
            ownerPID: 4242,
            accessibilityFrame: frame,
            accessibilityTitle: "Codex",
            candidates: [
                candidate(number: 20, title: "Settings"),
                candidate(number: 21, title: "Codex"),
            ]
        ), 21)

        XCTAssertNil(WindowNumberMatcher.uniqueWindowNumber(
            ownerPID: 4242,
            accessibilityFrame: frame,
            accessibilityTitle: "Codex",
            candidates: [candidate(number: 20, title: "Settings")]
        ))
    }

    func testTitleBarOrShadowOffsetCannotBeMistakenForTheAXWindowFrame() {
        XCTAssertNil(WindowNumberMatcher.uniqueWindowNumber(
            ownerPID: 4242,
            accessibilityFrame: frame,
            accessibilityTitle: "Codex",
            candidates: [
                candidate(
                    number: 30,
                    frame: ComputerFrame(x: 417, y: 225, width: 913, height: 689)
                ),
            ]
        ))
        XCTAssertNil(WindowNumberMatcher.uniqueWindowNumber(
            ownerPID: 4242,
            accessibilityFrame: frame,
            accessibilityTitle: "Codex",
            candidates: [
                candidate(
                    number: 31,
                    frame: ComputerFrame(x: 407, y: 193, width: 933, height: 731)
                ),
            ]
        ))
    }

    func testRetinaWindowMetadataIsMatchedInPointsNotBackingPixels() {
        let retinaPoints = ComputerFrame(x: 720, y: 180, width: 640, height: 480)
        XCTAssertEqual(WindowNumberMatcher.uniqueWindowNumber(
            ownerPID: 4242,
            accessibilityFrame: retinaPoints,
            accessibilityTitle: "Codex",
            candidates: [candidate(number: 40, frame: retinaPoints)]
        ), 40)
        XCTAssertNil(WindowNumberMatcher.uniqueWindowNumber(
            ownerPID: 4242,
            accessibilityFrame: retinaPoints,
            accessibilityTitle: "Codex",
            candidates: [
                candidate(
                    number: 41,
                    frame: ComputerFrame(x: 1_440, y: 360, width: 1_280, height: 960)
                ),
            ]
        ))
    }
}
