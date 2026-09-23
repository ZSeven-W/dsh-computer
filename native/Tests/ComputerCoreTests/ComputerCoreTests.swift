import XCTest
@testable import ComputerCore

final class ComputerCoreTests: XCTestCase {
    private func target(name: String? = "Save", identifier: String = "primary", secure: Bool = false) -> ElementIdentity {
        ElementIdentity(
            role: "AXButton", subrole: nil, name: name, identifier: identifier,
            frame: ComputerFrame(x: 10, y: 20, width: 80, height: 24), enabled: true,
            focused: false, secure: secure, actions: ["AXPress"], value: nil
        )
    }

    private func approval(
        action: ActionPayload,
        riskCode: ActionRiskCode,
        mutate: ((inout [String: Any]) -> Void)? = nil
    ) throws -> HostApprovalGrant {
        var object: [String: Any] = [
            "outcome": "allowed-once",
            "observationId": "obs_fixture-1",
            "observationFingerprint": String(repeating: "a", count: 64),
            "riskCode": riskCode.rawValue,
            "actionDigest": try XCTUnwrap(ActionApprovalBinding.digest(action: action)),
            "nonce": String(repeating: "A", count: 43),
            "refDigest": String(repeating: "b", count: 64),
        ]
        mutate?(&object)
        return try JSONDecoder().decode(HostApprovalGrant.self, from: JSONSerialization.data(withJSONObject: object))
    }

    func testInteractiveSessionRequiresAllPositiveSignals() {
        let available = InteractiveSessionPolicy.evaluate(InteractiveSessionSignals(
            frontmostBundleIdentifier: "dev.example.Editor",
            loginDone: true,
            onConsole: true,
            screenLocked: false
        ))
        XCTAssertEqual(
            available,
            InteractiveSessionAvailability(sessionLocked: false, interactiveSessionAvailable: true)
        )
    }

    func testUnlockedWindowServerMayOmitScreenLockedKey() {
        let available = InteractiveSessionPolicy.evaluate(InteractiveSessionSignals(
            frontmostBundleIdentifier: "dev.example.Editor",
            loginDone: true,
            onConsole: true,
            screenLocked: nil
        ))
        XCTAssertEqual(
            available,
            InteractiveSessionAvailability(sessionLocked: false, interactiveSessionAvailable: true)
        )
    }

    func testLoginWindowAlwaysFailsClosedEvenWhenCGSessionIsLoggedInOnConsole() {
        let locked = InteractiveSessionPolicy.evaluate(InteractiveSessionSignals(
            frontmostBundleIdentifier: InteractiveSessionPolicy.loginWindowBundleIdentifier,
            loginDone: true,
            onConsole: true,
            screenLocked: true
        ))
        XCTAssertEqual(
            locked,
            InteractiveSessionAvailability(sessionLocked: true, interactiveSessionAvailable: false)
        )
    }

    func testIncompleteOffConsoleAndMissingSessionSignalsFailClosed() {
        let cases = [
            InteractiveSessionSignals(
                frontmostBundleIdentifier: "dev.example.Editor", loginDone: false,
                onConsole: true, screenLocked: false
            ),
            InteractiveSessionSignals(
                frontmostBundleIdentifier: "dev.example.Editor", loginDone: true,
                onConsole: false, screenLocked: false
            ),
            InteractiveSessionSignals(
                frontmostBundleIdentifier: "dev.example.Editor", loginDone: true,
                onConsole: true, screenLocked: true
            ),
        ]
        for signals in cases {
            XCTAssertEqual(
                InteractiveSessionPolicy.evaluate(signals),
                InteractiveSessionAvailability(sessionLocked: true, interactiveSessionAvailable: false)
            )
        }
    }

    func testMissingSignalsAreUnavailableWithoutClaimingAProvenLock() {
        let cases = [
            InteractiveSessionSignals(
                frontmostBundleIdentifier: "dev.example.Editor", loginDone: nil,
                onConsole: true, screenLocked: false
            ),
            InteractiveSessionSignals(
                frontmostBundleIdentifier: nil, loginDone: true,
                onConsole: true, screenLocked: false
            ),
            InteractiveSessionSignals(
                frontmostBundleIdentifier: nil, loginDone: nil,
                onConsole: nil, screenLocked: nil
            ),
        ]
        for signals in cases {
            XCTAssertEqual(
                InteractiveSessionPolicy.evaluate(signals),
                InteractiveSessionAvailability(sessionLocked: false, interactiveSessionAvailable: false)
            )
        }
    }

    func testSecureTypingIsAPermanentHardDeny() {
        XCTAssertEqual(
            RiskPolicy.classify(action: ActionPayload(kind: "type", text: "secret"), target: target(secure: true)),
            .hardDeny(code: .secureText, reason: "secure text entry is permanently blocked")
        )
    }

    func testDangerousClickSemanticsRequireApprovalWithoutSubstringFalsePositives() {
        XCTAssertEqual(
            RiskPolicy.classify(action: ActionPayload(kind: "click"), target: target(name: "Delete account")),
            .approvalRequired(
                code: .dangerousClick,
                reason: "target semantics indicate a destructive operation and require one-action host approval"
            )
        )
        XCTAssertEqual(
            RiskPolicy.classify(action: ActionPayload(kind: "click"), target: target(name: "确认支付")),
            .approvalRequired(
                code: .dangerousClick,
                reason: "target semantics indicate a financial operation and require one-action host approval"
            )
        )
        XCTAssertEqual(
            RiskPolicy.classify(action: ActionPayload(kind: "click"), target: target(name: "Open sender settings")),
            .safe
        )
    }

    func testCommitKeysRequireApprovalEvenWithoutModelSuppliedRiskMetadata() {
        for key in ["Return", "enter", "numpadenter", "\n", "\r", "↩"] {
            XCTAssertEqual(
                RiskPolicy.classify(action: ActionPayload(kind: "key", key: key), target: target(name: "Message")),
                .approvalRequired(code: .commitKey, reason: "commit key requires one-action host approval")
            )
        }
    }

    func testKeyPolicyIsAnExplicitNavigationAllowlist() {
        for (key, modifiers) in [("j", ["control"]), ("m", ["control"]), ("k", ["command"])] {
            XCTAssertEqual(
                RiskPolicy.classify(
                    action: ActionPayload(kind: "key", key: key, modifiers: modifiers), target: target(name: "Editor")
                ),
                .approvalRequired(
                    code: .unsafeKeyChord,
                    reason: "key chord outside the safe navigation allowlist requires one-action host approval"
                )
            )
        }
        XCTAssertEqual(
            RiskPolicy.classify(
                action: ActionPayload(kind: "key", key: "left", modifiers: ["option"]), target: target(name: "Editor")
            ),
            .safe
        )
        XCTAssertEqual(
            RiskPolicy.classify(
                action: ActionPayload(kind: "key", key: "tab", modifiers: ["shift"]), target: target(name: "Editor")
            ),
            .safe
        )
    }

    func testEscapeAndArrowAliasesAreNavigationKeys() {
        for key in ["esc", "Esc", " ESC ", "arrowleft", "ArrowRight", "ARROWUP", "arrowdown"] {
            XCTAssertEqual(
                RiskPolicy.classify(action: ActionPayload(kind: "key", key: key), target: target(name: "Editor")),
                .safe, key
            )
        }
        XCTAssertEqual(RiskPolicy.normalizedKey("Esc"), "escape")
        XCTAssertEqual(RiskPolicy.normalizedKey("ArrowLeft"), "left")
        XCTAssertEqual(
            ActionApprovalBinding.digest(action: ActionPayload(kind: "key", key: "esc")),
            ActionApprovalBinding.digest(action: ActionPayload(kind: "key", key: "escape"))
        )
        XCTAssertNotEqual(
            RiskPolicy.classify(action: ActionPayload(kind: "key", key: "7"), target: target(name: "Keypad")),
            .safe
        )
    }

    func testClearButtonsAreNotDestructiveInEitherLanguage() {
        for (name, identifier) in [("清除", "Clear"), ("全部清除", "AllClear"), ("Clear", "Clear")] {
            XCTAssertEqual(
                RiskPolicy.classify(action: ActionPayload(kind: "click"), target: target(name: name, identifier: identifier)),
                .safe, name
            )
        }
        for name in ["删除", "删除备忘录", "抹掉磁盘", "卸载", "销毁"] {
            XCTAssertEqual(
                RiskPolicy.classify(action: ActionPayload(kind: "click"), target: target(name: name)),
                .approvalRequired(
                    code: .dangerousClick,
                    reason: "target semantics indicate a destructive operation and require one-action host approval"
                ), name
            )
        }
    }

    func testFocusPlainTypingAndOrdinaryClickAreSafe() {
        XCTAssertEqual(RiskPolicy.classify(action: ActionPayload(kind: "focus"), target: target()), .safe)
        XCTAssertEqual(RiskPolicy.classify(action: ActionPayload(kind: "type", text: "hello"), target: target()), .safe)
        XCTAssertEqual(RiskPolicy.classify(action: ActionPayload(kind: "click"), target: target(name: "Open")), .safe)
    }

    func testScrollIsSafeAndNeverRequiresApproval() {
        XCTAssertEqual(
            RiskPolicy.classify(action: ActionPayload(kind: "scroll", direction: "down"), target: target(name: "List")),
            .safe
        )
        XCTAssertEqual(
            RiskPolicy.classify(
                action: ActionPayload(kind: "scroll", direction: "up", amount: .points(120)), target: target(name: "List")
            ),
            .safe
        )
        XCTAssertNil(ActionApprovalBinding.digest(action: ActionPayload(kind: "scroll", direction: "down", amount: .page)))
    }

    func testScrollIsNeverReportedConfirmedFromDispatchAlone() {
        let before = target(name: "List")
        XCTAssertFalse(ActionConfirmation.isConfirmed(
            action: ActionPayload(kind: "scroll", direction: "down", amount: .page),
            before: before, post: before, postIdentityMatches: true
        ))
    }

    func testScrollAmountDecodesLinePageAndPositivePoints() throws {
        func decode(_ json: String) throws -> ScrollAmount {
            try JSONDecoder().decode(ScrollAmount.self, from: Data(json.utf8))
        }
        XCTAssertEqual(try decode(#""line""#), .line)
        XCTAssertEqual(try decode(#""page""#), .page)
        XCTAssertEqual(try decode("150"), .points(150))
        XCTAssertThrowsError(try decode("0"))
        XCTAssertThrowsError(try decode("-1"))
        XCTAssertThrowsError(try decode(#""bogus""#))
    }

    func testActionDigestMatchesTheTypeScriptCanonicalV1Contract() {
        XCTAssertEqual(
            ActionApprovalBinding.digest(action: ActionPayload(kind: "click")),
            "fa80c81977738372f15520edacfcee5d110152a43b1c7d971835f85644fd0cc4"
        )
        XCTAssertEqual(
            ActionApprovalBinding.digest(action: ActionPayload(kind: "key", key: "Enter")),
            "402002130f1cf3545a39e173c86e203a96d2e6287be919e727ae5e83f37ba66a"
        )
        XCTAssertEqual(
            ActionApprovalBinding.digest(
                action: ActionPayload(kind: "key", key: "j", modifiers: ["control", "control"])
            ),
            "7fdde1edb66a213c14c12c35b7d1eb61587f33f828d23c884ceff049497c5a08"
        )
        XCTAssertEqual(
            ActionApprovalBinding.digest(action: ActionPayload(kind: "type", text: "你好\nA")),
            "88c3705d1f11f4d4f17a491f24b2be04f41536b51577a24db23d48a7ec4741a9"
        )
        XCTAssertNil(ActionApprovalBinding.digest(
            action: ActionPayload(kind: "key", key: "j", modifiers: ["caps-lock"])
        ))
    }

    func testApprovalDecoderRequiresAnExactBoundedGrantShape() throws {
        let action = ActionPayload(kind: "click")
        let valid = try approval(action: action, riskCode: .dangerousClick)
        XCTAssertEqual(valid.outcome, "allowed-once")
        XCTAssertEqual(valid.observationId, "obs_fixture-1")
        XCTAssertEqual(valid.riskCode, .dangerousClick)

        let invalidMutations: [(inout [String: Any]) -> Void] = [
            { $0["outcome"] = "rejected" },
            { $0["observationId"] = "" },
            { $0["observationId"] = "fixture-1" },
            { $0["observationId"] = "obs_" + String(repeating: "a", count: 125) },
            { $0["observationFingerprint"] = String(repeating: "A", count: 64) },
            { $0["actionDigest"] = String(repeating: "0", count: 63) },
            { $0["refDigest"] = String(repeating: "g", count: 64) },
            { $0["riskCode"] = "secure-text" },
            { $0["nonce"] = String(repeating: "A", count: 42) },
            { $0["unexpected"] = "field" },
            { $0.removeValue(forKey: "refDigest") },
        ]
        for mutation in invalidMutations {
            XCTAssertThrowsError(try approval(action: action, riskCode: .dangerousClick, mutate: mutation))
        }
    }

    func testValidOneActionGrantsAuthorizeOnlyTheirExactRiskAndAction() throws {
        let dangerousClick = ActionPayload(kind: "click")
        let returnKey = ActionPayload(kind: "key", key: "Return")
        let controlJ = ActionPayload(kind: "key", key: "j", modifiers: ["control"])

        XCTAssertNil(RiskPolicy.rejection(
            action: dangerousClick,
            target: target(name: "Delete account"),
            approval: try approval(action: dangerousClick, riskCode: .dangerousClick)
        ))
        XCTAssertNil(RiskPolicy.rejection(
            action: returnKey,
            target: target(name: "Message"),
            approval: try approval(action: returnKey, riskCode: .commitKey)
        ))
        XCTAssertNil(RiskPolicy.rejection(
            action: controlJ,
            target: target(name: "Editor"),
            approval: try approval(action: controlJ, riskCode: .unsafeKeyChord)
        ))

        XCTAssertNotNil(RiskPolicy.rejection(
            action: dangerousClick, target: target(name: "Delete account"), approval: nil
        ))
        XCTAssertNotNil(RiskPolicy.rejection(
            action: dangerousClick,
            target: target(name: "Delete account"),
            approval: try approval(action: dangerousClick, riskCode: .commitKey)
        ))
        XCTAssertNotNil(RiskPolicy.rejection(
            action: dangerousClick,
            target: target(name: "Delete account"),
            approval: try approval(action: dangerousClick, riskCode: .dangerousClick) {
                $0["actionDigest"] = String(repeating: "0", count: 64)
            }
        ))
    }

    func testSecureTypingStaysDeniedEvenWithAWellFormedGrant() throws {
        let secureType = ActionPayload(kind: "type", text: "secret")
        XCTAssertEqual(
            RiskPolicy.rejection(
                action: secureType,
                target: target(secure: true),
                approval: try approval(action: secureType, riskCode: .dangerousClick)
            ),
            "secure text entry is permanently blocked"
        )
    }

    func testApprovalInsideActionPayloadCannotAuthorizeAnything() throws {
        let nested = try JSONSerialization.data(withJSONObject: [
            "kind": "click",
            "approval": ["outcome": "allowed-once", "nonce": "PRIVATE-GRANT"],
        ])
        let action = try JSONDecoder().decode(ActionPayload.self, from: nested)
        XCTAssertNotNil(RiskPolicy.rejection(
            action: action, target: target(name: "Delete account"), approval: nil
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

    func testProtocolIdentitiesEncodeRequiredOptionalFieldsAsExplicitNull() throws {
        func object<T: Encodable>(_ value: T) throws -> [String: Any] {
            try XCTUnwrap(
                JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any]
            )
        }

        let app = AppIdentity(bundleId: "dev.example.App", pid: 42, launchIdentity: nil, name: nil)
        let encodedApp = try object(app)
        XCTAssertEqual(Set(encodedApp.keys), Set(["bundleId", "pid", "launchIdentity", "name"]))
        XCTAssertTrue(encodedApp["launchIdentity"] is NSNull)
        XCTAssertTrue(encodedApp["name"] is NSNull)

        let window = WindowIdentity(
            number: nil, role: "AXWindow", subrole: nil, title: nil, frame: nil, identity: "window-digest"
        )
        let encodedWindow = try object(window)
        XCTAssertEqual(Set(encodedWindow.keys), Set(["number", "role", "subrole", "title", "frame", "identity"]))
        for key in ["number", "subrole", "title", "frame"] {
            XCTAssertTrue(encodedWindow[key] is NSNull, "expected explicit null for window.\(key)")
        }

        let element = ElementIdentity(
            role: "AXUnknown", subrole: nil, name: nil, identifier: nil, frame: nil,
            enabled: nil, focused: nil, secure: true, actions: [], value: "must-be-redacted"
        )
        let encodedElement = try object(element)
        XCTAssertEqual(
            Set(encodedElement.keys),
            Set(["role", "subrole", "name", "identifier", "frame", "enabled", "focused", "secure", "actions", "value"])
        )
        for key in ["subrole", "name", "identifier", "frame", "enabled", "focused", "value"] {
            XCTAssertTrue(encodedElement[key] is NSNull, "expected explicit null for element.\(key)")
        }

        XCTAssertEqual(try JSONDecoder().decode(AppIdentity.self, from: JSONEncoder().encode(app)), app)
        XCTAssertEqual(try JSONDecoder().decode(WindowIdentity.self, from: JSONEncoder().encode(window)), window)
        XCTAssertEqual(try JSONDecoder().decode(ElementIdentity.self, from: JSONEncoder().encode(element)), element)
    }
}
