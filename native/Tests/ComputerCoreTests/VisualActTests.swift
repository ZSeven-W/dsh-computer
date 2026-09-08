import XCTest
@testable import ComputerCore

/// Lightweight AX-tree stand-in for exercising the bounded hit-to-window
/// resolver without launching or querying user apps.
private final class FakeAXNode {
    let pid: Int32?
    var window: FakeAXNode?
    var parent: FakeAXNode?

    init(pid: Int32?, window: FakeAXNode? = nil, parent: FakeAXNode? = nil) {
        self.pid = pid
        self.window = window
        self.parent = parent
    }
}

final class VisualActTests: XCTestCase {
    private func point(_ x: Int, _ y: Int) -> NativeVisualPoint {
        NativeVisualPoint(x: x, y: y)
    }

    private func click(_ x: Int = 12, _ y: Int = 34) -> NativeVisualActionPayload {
        NativeVisualActionPayload(op: "click", point: point(x, y))
    }

    private func window(number: Int = 42, identity: String = "win-id") -> WindowIdentity {
        WindowIdentity(
            number: number,
            role: "AXWindow",
            subrole: nil,
            title: nil,
            frame: ComputerFrame(x: 10, y: 20, width: 100, height: 80),
            identity: identity
        )
    }

    private func approval(
        captureSha256: String = String(repeating: "a", count: 64),
        action: NativeVisualActionPayload = NativeVisualActionPayload(op: "click", point: NativeVisualPoint(x: 12, y: 34)),
        window: WindowIdentity = WindowIdentity(number: 42, role: "AXWindow", subrole: nil, title: nil, frame: nil, identity: "win-id")
    ) throws -> HostApprovalGrant {
        let object: [String: Any] = [
            "outcome": "allowed-once",
            "observationId": "obs_visual-1",
            "observationFingerprint": String(repeating: "a", count: 64),
            "riskCode": "visual-point-action",
            "actionDigest": try XCTUnwrap(VisualActionApprovalBinding.digest(captureSha256: captureSha256, action: action, window: window)),
            "nonce": String(repeating: "A", count: 43),
            "refDigest": String(repeating: "b", count: 64),
        ]
        return try JSONDecoder().decode(HostApprovalGrant.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func resolvesToExpectedWindow(
        _ hit: FakeAXNode,
        expectedPID: Int32 = 77,
        expectedWindow: FakeAXNode,
        maxTraversalNodes: Int = 24
    ) -> Bool {
        VisualPointHitProof.resolvesToExpectedWindow(
            from: hit,
            expectedPID: expectedPID,
            expectedWindow: expectedWindow,
            elementPID: { $0.pid },
            windowAttribute: { $0.window },
            parentAttribute: { $0.parent },
            elementsEqual: { $0 === $1 },
            maxTraversalNodes: maxTraversalNodes
        )
    }

    func testCoordinateMappingUsesActualWindowGeometryAndRetinaScale() throws {
        let global = try XCTUnwrap(VisualCoordinateMapper.globalPoint(
            native: point(100, 80),
            pointFrame: ComputerFrame(x: 400, y: 300, width: 800, height: 600),
            scaleX: 2,
            scaleY: 2,
            pixelWidth: 1_600,
            pixelHeight: 1_200
        ))
        XCTAssertEqual(global.x, 450, accuracy: 0.000_1)
        XCTAssertEqual(global.y, 340, accuracy: 0.000_1)

        let offCenter = try XCTUnwrap(VisualCoordinateMapper.globalPoint(
            native: point(12, 9),
            pointFrame: ComputerFrame(x: 720, y: 180, width: 640, height: 480),
            scaleX: 1.5,
            scaleY: 1.5,
            pixelWidth: 960,
            pixelHeight: 720
        ))
        XCTAssertEqual(offCenter.x, 728, accuracy: 0.000_1)
        XCTAssertEqual(offCenter.y, 186, accuracy: 0.000_1)
    }

    func testCoordinateMappingRejectsOutsideAndNonFiniteGeometry() {
        let frame = ComputerFrame(x: 400, y: 300, width: 800, height: 600)
        XCTAssertNil(VisualCoordinateMapper.globalPoint(
            native: point(800, 50),
            pointFrame: frame,
            scaleX: 1,
            scaleY: 1,
            pixelWidth: 800,
            pixelHeight: 600
        ))
        XCTAssertNil(VisualCoordinateMapper.globalPoint(
            native: point(50, 600),
            pointFrame: frame,
            scaleX: 1,
            scaleY: 1,
            pixelWidth: 800,
            pixelHeight: 600
        ))
        XCTAssertNil(VisualCoordinateMapper.globalPoint(
            native: point(-1, 50),
            pointFrame: frame,
            scaleX: 1,
            scaleY: 1,
            pixelWidth: 800,
            pixelHeight: 600
        ))
        XCTAssertNil(VisualCoordinateMapper.globalPoint(
            native: point(1, 1),
            pointFrame: ComputerFrame(x: .nan, y: 0, width: 1, height: 1),
            scaleX: 1,
            scaleY: 1,
            pixelWidth: 1,
            pixelHeight: 1
        ))
    }

    func testPathValidationBoundsAndRequiredDragEndpoints() throws {
        XCTAssertNil(VisualActionPathValidator.failure(
            action: click(), pixelWidth: 100, pixelHeight: 100
        ))
        XCTAssertNotNil(VisualActionPathValidator.failure(
            action: click(100, 50), pixelWidth: 100, pixelHeight: 100
        ))
        XCTAssertNotNil(VisualActionPathValidator.failure(
            action: click(-1, 50), pixelWidth: 100, pixelHeight: 100
        ))

        let drag = NativeVisualActionPayload(
            op: "drag",
            point: point(10, 10),
            to: point(20, 20)
        )
        XCTAssertNil(VisualActionPathValidator.failure(
            action: drag, pixelWidth: 100, pixelHeight: 100
        ))
        let missingTo = NativeVisualActionPayload(op: "drag", point: point(10, 10))
        XCTAssertNotNil(VisualActionPathValidator.failure(
            action: missingTo, pixelWidth: 100, pixelHeight: 100
        ))
        let outOfBoundsTo = NativeVisualActionPayload(
            op: "drag", point: point(10, 10), to: point(101, 20)
        )
        XCTAssertNotNil(VisualActionPathValidator.failure(
            action: outOfBoundsTo, pixelWidth: 100, pixelHeight: 100
        ))

        let scroll = NativeVisualActionPayload(
            op: "scroll", point: point(50, 50), direction: "down", amount: .page
        )
        XCTAssertNil(VisualActionPathValidator.failure(
            action: scroll, pixelWidth: 100, pixelHeight: 100
        ))
        XCTAssertNotNil(VisualActionPathValidator.failure(
            action: NativeVisualActionPayload(op: "scroll", point: point(50, 50), direction: "sideways", amount: .line),
            pixelWidth: 100,
            pixelHeight: 100
        ))
    }

    func testPathValidationRejectsExtraneousPayloadFieldsByOperation() {
        let clickWithTo = NativeVisualActionPayload(op: "click", point: point(1, 1), to: point(2, 2))
        XCTAssertNotNil(VisualActionPathValidator.failure(
            action: clickWithTo, pixelWidth: 100, pixelHeight: 100
        ))
        let dragWithDirection = NativeVisualActionPayload(
            op: "drag", point: point(1, 1), to: point(2, 2), direction: "down"
        )
        XCTAssertNotNil(VisualActionPathValidator.failure(
            action: dragWithDirection, pixelWidth: 100, pixelHeight: 100
        ))
    }

    func testVisualDigestMatchesTypeScriptCanonicalVectors() throws {
        let clickWindow = window(number: 42, identity: "win-id")
        XCTAssertEqual(
            VisualActionApprovalBinding.digest(
                captureSha256: String(repeating: "a", count: 64),
                action: click(12, 34),
                window: clickWindow
            ),
            "6c9cd147fae81724b922fa9c1c73e11fbd7b4def1348ef873acb2348327c4877"
        )

        let dragWindow = window(number: 7, identity: "drag-window")
        let drag = NativeVisualActionPayload(op: "drag", point: point(1, 2), to: point(3, 4))
        XCTAssertEqual(
            VisualActionApprovalBinding.digest(
                captureSha256: String(repeating: "b", count: 64),
                action: drag,
                window: dragWindow
            ),
            "47c673755dfcc42abebc074bc532ae4b9a99f1b7f69504a02074cb565282c17a"
        )

        let scrollWindow = window(number: 7, identity: "scroll-window")
        let scroll = NativeVisualActionPayload(
            op: "scroll", point: point(5, 6), direction: "down", amount: .points(12.5)
        )
        XCTAssertEqual(
            VisualActionApprovalBinding.digest(
                captureSha256: String(repeating: "c", count: 64),
                action: scroll,
                window: scrollWindow
            ),
            "cbc610a6dd994e547afdef89fbb882358857bf6250d58fb082514d6dbef6e416"
        )
    }

    func testVisualActionAlwaysRequiresExactOneActionApproval() throws {
        let window = self.window()
        let action = click(12, 34)
        let sha = String(repeating: "a", count: 64)

        XCTAssertNotNil(VisualActionPolicy.rejection(
            captureSha256: sha, action: action, window: window, approval: nil
        ))
        XCTAssertNil(VisualActionPolicy.rejection(
            captureSha256: sha,
            action: action,
            window: window,
            approval: try approval(captureSha256: sha, action: action, window: window)
        ))

        var badObject: [String: Any] = [
            "outcome": "allowed-once",
            "observationId": "obs_visual-1",
            "observationFingerprint": String(repeating: "a", count: 64),
            "riskCode": "visual-point-action",
            "actionDigest": String(repeating: "0", count: 64),
            "nonce": String(repeating: "A", count: 43),
            "refDigest": String(repeating: "b", count: 64),
        ]
        let bad = try JSONDecoder().decode(
            HostApprovalGrant.self,
            from: JSONSerialization.data(withJSONObject: badObject)
        )
        XCTAssertNotNil(VisualActionPolicy.rejection(
            captureSha256: sha, action: action, window: window, approval: bad
        ))

        badObject["riskCode"] = "dangerous-click"
        badObject["actionDigest"] = String(repeating: "0", count: 64)
        let wrongRisk = try JSONDecoder().decode(
            HostApprovalGrant.self,
            from: JSONSerialization.data(withJSONObject: badObject)
        )
        XCTAssertNotNil(VisualActionPolicy.rejection(
            captureSha256: sha, action: action, window: window, approval: wrongRisk
        ))
    }

    func testVisualApprovalIsBoundToCaptureShaAndWindowIdentity() throws {
        let sha = String(repeating: "a", count: 64)
        let action = click(12, 34)
        let original = window(number: 42, identity: "win-id")
        let valid = try approval(captureSha256: sha, action: action, window: original)
        XCTAssertNil(VisualActionPolicy.rejection(
            captureSha256: sha, action: action, window: original, approval: valid
        ))
        XCTAssertNotNil(VisualActionPolicy.rejection(
            captureSha256: String(repeating: "b", count: 64),
            action: action,
            window: original,
            approval: valid
        ))
        let changedWindow = window(number: 43, identity: "win-id")
        XCTAssertNotNil(VisualActionPolicy.rejection(
            captureSha256: sha, action: action, window: changedWindow, approval: valid
        ))
        let changedIdentity = window(number: 42, identity: "another-window-id")
        XCTAssertNotNil(VisualActionPolicy.rejection(
            captureSha256: sha, action: action, window: changedIdentity, approval: valid
        ))
    }

    func testVisualDigestAndPolicyRejectMissingWindowNumberOrUnsupportedOp() throws {
        let sha = String(repeating: "a", count: 64)
        let noNumber = WindowIdentity(number: nil, role: "AXWindow", subrole: nil, title: nil, frame: nil, identity: "win-id")
        XCTAssertNil(VisualActionApprovalBinding.digest(captureSha256: sha, action: click(), window: noNumber))
        let unsupported = NativeVisualActionPayload(op: "type", point: point(1, 1))
        XCTAssertNil(VisualActionApprovalBinding.digest(captureSha256: sha, action: unsupported, window: window()))
    }

    func testHostApprovalDecoderAcceptsVisualPointActionRiskCode() throws {
        let approval = try self.approval()
        XCTAssertEqual(approval.riskCode, .visualPointAction)
        XCTAssertEqual(approval.outcome, "allowed-once")
    }

    func testExactAXWindowHitProvesVisibleEvenWhenAXWindowAttributeIsUnsupported() {
        let target = FakeAXNode(pid: 77)
        // The hit may itself be the AXWindow; no AXWindow attribute is needed.
        XCTAssertTrue(resolvesToExpectedWindow(target, expectedWindow: target))
    }

    func testTransparentOverlayCandidateAboveTargetIsNotAloneAccepted() {
        let target = FakeAXNode(pid: 77)
        let overlayWindow = FakeAXNode(pid: 78)
        // A background/foreign overlay hit must never be relabeled as the
        // expected window by position or title. Exact proof succeeds only for
        // the same live AX window/PID.
        XCTAssertFalse(resolvesToExpectedWindow(overlayWindow, expectedWindow: target))
        XCTAssertFalse(resolvesToExpectedWindow(target, expectedPID: 78, expectedWindow: target))
        XCTAssertTrue(resolvesToExpectedWindow(target, expectedWindow: target))
    }

    func testDescendantResolvesThroughAXWindowOrBoundedParentTraversal() {
        let target = FakeAXNode(pid: 77)
        let childWithWindowAttribute = FakeAXNode(pid: 77, window: target)
        XCTAssertTrue(resolvesToExpectedWindow(childWithWindowAttribute, expectedWindow: target))

        let parentedChild = FakeAXNode(pid: 77, parent: FakeAXNode(pid: 77, parent: target))
        XCTAssertTrue(resolvesToExpectedWindow(parentedChild, expectedWindow: target))
    }

    func testOtherOwnerDifferentWindowAndUnknownPIDReject() {
        let target = FakeAXNode(pid: 77)
        let otherWindowSameOwner = FakeAXNode(pid: 77)
        XCTAssertFalse(resolvesToExpectedWindow(otherWindowSameOwner, expectedWindow: target))
        XCTAssertFalse(resolvesToExpectedWindow(FakeAXNode(pid: nil, window: target), expectedWindow: target))
        XCTAssertFalse(resolvesToExpectedWindow(FakeAXNode(pid: 77, window: FakeAXNode(pid: 99, window: target)), expectedWindow: target))
    }

    func testFailedLookupCycleAndOverrunFailClosed() {
        let target = FakeAXNode(pid: 77)
        let cycleA = FakeAXNode(pid: 77)
        let cycleB = FakeAXNode(pid: 77)
        cycleA.parent = cycleB
        cycleB.parent = cycleA
        XCTAssertFalse(resolvesToExpectedWindow(cycleA, expectedWindow: target))

        let root = FakeAXNode(pid: 77, parent: FakeAXNode(pid: 77, parent: target))
        XCTAssertFalse(resolvesToExpectedWindow(root, expectedWindow: target, maxTraversalNodes: 1))
    }
}
