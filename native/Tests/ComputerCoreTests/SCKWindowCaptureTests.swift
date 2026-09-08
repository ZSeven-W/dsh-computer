import CoreGraphics
import Foundation
import XCTest
@testable import ComputerCore

final class SCKWindowCaptureTests: XCTestCase {
    func testBoundedTimeoutReturnsWhenWorkIgnoresCancellation() async {
        let start = Date()
        do {
            _ = try await BoundedAsyncTimeout.run(timeout: 0.05) { () async -> Int in
                await withUnsafeContinuation { (_: UnsafeContinuation<Int, Never>) in
                    // This continuation never resumes, intentionally proving the
                    // caller is not blocked by an uncooperative cancelled task.
                }
            }
            XCTFail("expected a timeout error")
        } catch let error as SCKCaptureError {
            guard case .timedOut = error else {
                return XCTFail("expected timedOut, got \(error)")
            }
            XCTAssertLessThan(Date().timeIntervalSince(start), 2.0)
        } catch {
            XCTFail("expected SCKCaptureError.timedOut, got \(error)")
        }
    }

    func testBoundedTimeoutRejectsNonFiniteAndNonPositiveTimeouts() async {
        for timeout in [0.0, -1.0, .infinity] {
            do {
                _ = try await BoundedAsyncTimeout.run(timeout: timeout) {
                    1
                }
                XCTFail("expected invalid timeout failure for \(timeout)")
            } catch let error as SCKCaptureError {
                guard case .timedOut = error else {
                    return XCTFail("expected timedOut, got \(error)")
                }
            } catch {
                XCTFail("expected SCKCaptureError.timedOut, got \(error)")
            }
        }
    }

    func testBoundedTimeoutReturnsFastSuccess() async throws {
        let value = try await BoundedAsyncTimeout.run(timeout: 5.0) {
            42
        }
        XCTAssertEqual(value, 42)
    }

    func testSCKCaptureErrorDescriptionsCoverKnownFailureModes() {
        XCTAssertTrue(SCKCaptureError.invalidWindowID.debugDescription.contains("non-zero"))
        XCTAssertTrue(SCKCaptureError.invalidOwnerPID.debugDescription.contains("positive"))
        XCTAssertTrue(SCKCaptureError.invalidExpectedFrame.debugDescription.contains("finite"))
        XCTAssertTrue(SCKCaptureError.permissionDenied.debugDescription.contains("Screen Recording"))
        XCTAssertTrue(SCKCaptureError.timedOut(seconds: 3).debugDescription.contains("3.0"))
        XCTAssertTrue(SCKCaptureError.unsafePixelDimensions(width: 0, height: 1).debugDescription.contains("0x1"))
    }

    @available(macOS 14.0, *)
    func testSCKValidationRejectsInvalidMetadataAndUnsafeDimensions() throws {
        func assertThrowsSCKError<T>(
            _ expression: @autoclosure () throws -> T,
            _ expected: SCKCaptureError,
            _ message: String
        ) {
            do {
                _ = try expression()
                XCTFail(message)
            } catch let error as SCKCaptureError {
                XCTAssertEqual(error, expected)
            } catch {
                XCTFail("\(message) got \(error)")
            }
        }

        assertThrowsSCKError(
            try SCKWindowCapture.validate(windowID: 0, ownerPID: 1, expectedFrame: CGRect(x: 0, y: 0, width: 10, height: 10)),
            .invalidWindowID,
            "zero window ID should fail"
        )
        assertThrowsSCKError(
            try SCKWindowCapture.validate(windowID: 1, ownerPID: 0, expectedFrame: CGRect(x: 0, y: 0, width: 10, height: 10)),
            .invalidOwnerPID,
            "zero owner PID should fail"
        )
        assertThrowsSCKError(
            try SCKWindowCapture.validate(windowID: 1, ownerPID: 1, expectedFrame: CGRect(x: 0, y: 0, width: 0, height: 10)),
            .invalidExpectedFrame,
            "empty frame should fail"
        )
        assertThrowsSCKError(
            try SCKWindowCapture.validatePixelDimensions(width: 0, height: 10),
            .unsafePixelDimensions(width: 0, height: 10),
            "zero width should fail"
        )
        assertThrowsSCKError(
            try SCKWindowCapture.validatePixelDimensions(width: 33_000, height: 10),
            .unsafePixelDimensions(width: 33_000, height: 10),
            "over-long side should fail"
        )
    }

    @available(macOS 14.0, *)
    func testSCKValidationAcceptsValidMetadata() throws {
        XCTAssertNoThrow(try SCKWindowCapture.validate(
            windowID: 42,
            ownerPID: 7,
            expectedFrame: CGRect(x: -100, y: 200, width: 640, height: 480)
        ))
        XCTAssertNoThrow(try SCKWindowCapture.validatePixelDimensions(width: 1, height: 32_768))
    }
}
