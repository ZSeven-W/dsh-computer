import XCTest
@testable import ComputerCore

final class PostedInputDrainTests: XCTestCase {
    func testDrainIsFixedBoundedAndInvokedOnlyOnce() {
        var delays: [TimeInterval] = []
        PostedInputDrain.wait { delays.append($0) }
        XCTAssertEqual(delays, [0.1])
        XCTAssertTrue(PostedInputDrain.duration.isFinite)
        XCTAssertGreaterThan(PostedInputDrain.duration, 0)
        XCTAssertLessThanOrEqual(PostedInputDrain.duration, 0.25)
    }
}
