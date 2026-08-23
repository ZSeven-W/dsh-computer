import XCTest
@testable import ComputerCore

final class ComputerCoreTests: XCTestCase {
    private func target(name: String? = "Save", secure: Bool = false) -> ElementIdentity {
        ElementIdentity(
            role: "AXButton", subrole: nil, name: name, identifier: "primary",
            frame: ComputerFrame(x: 10, y: 20, width: 80, height: 24), enabled: true,
            focused: false, secure: secure, actions: ["AXPress"], value: nil
        )
    }

    func testBlocksSecureTypingWithoutCallerSensitivityFlag() {
        let reason = RiskPolicy.rejection(action: ActionPayload(kind: "type", text: "secret"), target: target(secure: true))
        XCTAssertEqual(reason, "secure text entry is blocked")
    }

    func testBlocksDestructiveAndFinancialSemantics() {
        XCTAssertNotNil(RiskPolicy.rejection(action: ActionPayload(kind: "click"), target: target(name: "Delete account")))
        XCTAssertNotNil(RiskPolicy.rejection(action: ActionPayload(kind: "click"), target: target(name: "确认支付")))
        XCTAssertNil(RiskPolicy.rejection(action: ActionPayload(kind: "click"), target: target(name: "Open settings")))
    }

    func testBlocksCommitKeysEvenWithoutModelSuppliedRiskMetadata() {
        XCTAssertNotNil(RiskPolicy.rejection(action: ActionPayload(kind: "key", key: "Return"), target: target(name: "Message")))
        XCTAssertNotNil(RiskPolicy.rejection(action: ActionPayload(kind: "key", key: "enter", modifiers: ["shift"]), target: target(name: "Editor")))
    }

    func testKeyPolicyIsAnExplicitNavigationAllowlist() {
        XCTAssertNotNil(RiskPolicy.rejection(
            action: ActionPayload(kind: "key", key: "j", modifiers: ["control"]), target: target(name: "Editor")
        ))
        XCTAssertNotNil(RiskPolicy.rejection(
            action: ActionPayload(kind: "key", key: "m", modifiers: ["control"]), target: target(name: "Editor")
        ))
        XCTAssertNotNil(RiskPolicy.rejection(
            action: ActionPayload(kind: "key", key: "k", modifiers: ["command"]), target: target(name: "Editor")
        ))
        XCTAssertNil(RiskPolicy.rejection(
            action: ActionPayload(kind: "key", key: "left", modifiers: ["option"]), target: target(name: "Editor")
        ))
        XCTAssertNil(RiskPolicy.rejection(
            action: ActionPayload(kind: "key", key: "tab", modifiers: ["shift"]), target: target(name: "Editor")
        ))
    }

    func testClickConfirmationRequiresSameTargetAndActionSpecificProof() {
        let before = target(name: "Toggle")
        XCTAssertFalse(ActionConfirmation.isConfirmed(
            action: ActionPayload(kind: "click"), before: before, post: nil, postIdentityMatches: false
        ))
        let rebound = target(name: "Replacement")
        XCTAssertFalse(ActionConfirmation.isConfirmed(
            action: ActionPayload(kind: "click"), before: before, post: rebound, postIdentityMatches: false
        ))
        let toggled = ElementIdentity(
            role: before.role, subrole: before.subrole, name: before.name, identifier: before.identifier,
            frame: before.frame, enabled: before.enabled, focused: before.focused, secure: false,
            actions: before.actions, value: "1"
        )
        XCTAssertTrue(ActionConfirmation.isConfirmed(
            action: ActionPayload(kind: "click"), before: before, post: toggled, postIdentityMatches: true
        ))
    }

    func testLaunchIdentityIsMandatoryForPreflight() {
        let expected = AppIdentity(bundleId: "dev.example.App", pid: 10, launchIdentity: nil, name: "Example")
        let live = AppIdentity(bundleId: "dev.example.App", pid: 10, launchIdentity: nil, name: "Example")
        XCTAssertEqual(IdentityVerifier.app(expected: expected, live: live), .stale("application launch identity is missing or changed"))
    }

    func testElementRebindingAndFrameMovementAreRejected() {
        let expected = target(name: "Open")
        let rebound = target(name: "Close")
        XCTAssertEqual(IdentityVerifier.element(expected: expected, live: rebound), .stale("target name changed"))

        let moved = ElementIdentity(
            role: expected.role, subrole: expected.subrole, name: expected.name, identifier: expected.identifier,
            frame: ComputerFrame(x: 100, y: 20, width: 80, height: 24), enabled: true, focused: false,
            secure: false, actions: ["AXPress"], value: nil
        )
        XCTAssertEqual(IdentityVerifier.element(expected: expected, live: moved), .stale("target frame changed"))
    }

    func testNegativeZeroIsNormalizedAtNativeBoundary() {
        let frame = ComputerFrame(x: -0.0, y: -0.0, width: 1, height: 1)
        XCTAssertEqual(frame.x.sign, .plus)
        XCTAssertEqual(frame.y.sign, .plus)
    }
}
