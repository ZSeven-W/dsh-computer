import XCTest
@testable import ComputerCore

final class VisualCaptureTests: XCTestCase {
    func testOffCenterWindowAtOneXMapsGlobalPointsIntoTopOriginPixels() throws {
        let space = try CaptureCoordinateSpace(
            pointFrame: ComputerFrame(x: 400, y: 300, width: 800, height: 600),
            pixelWidth: 800,
            pixelHeight: 600
        )
        XCTAssertEqual(space.scaleX, 1)
        XCTAssertEqual(space.scaleY, 1)
        XCTAssertEqual(
            space.pixelFrame(for: ComputerFrame(x: 425, y: 330, width: 100, height: 50)),
            ComputerFrame(x: 25, y: 30, width: 100, height: 50)
        )
    }

    func testRetinaWindowMapsPointsAtTwoXWithoutAssumingScreenOrigin() throws {
        let space = try CaptureCoordinateSpace(
            pointFrame: ComputerFrame(x: 720, y: 180, width: 640, height: 480),
            pixelWidth: 1_280,
            pixelHeight: 960
        )
        XCTAssertEqual(space.scaleX, 2)
        XCTAssertEqual(space.scaleY, 2)
        XCTAssertEqual(
            space.pixelFrame(for: ComputerFrame(x: 745, y: 210, width: 100, height: 50)),
            ComputerFrame(x: 50, y: 60, width: 200, height: 100)
        )
    }

    func testNonIntegerScaleUsesFloorCeilAndClipsToWindow() throws {
        let space = try CaptureCoordinateSpace(
            pointFrame: ComputerFrame(x: 400, y: 300, width: 800, height: 600),
            pixelWidth: 1_200,
            pixelHeight: 900
        )
        XCTAssertEqual(space.scaleX, 1.5)
        XCTAssertEqual(space.scaleY, 1.5)
        XCTAssertEqual(
            space.pixelFrame(for: ComputerFrame(x: 410.2, y: 320.4, width: 20.4, height: 10.2)),
            ComputerFrame(x: 15, y: 30, width: 31, height: 16)
        )
        XCTAssertEqual(
            space.pixelFrame(for: ComputerFrame(x: 350, y: 250, width: 100, height: 100)),
            ComputerFrame(x: 0, y: 0, width: 75, height: 75)
        )
        XCTAssertNil(space.pixelFrame(for: ComputerFrame(x: 0, y: 0, width: 20, height: 20)))
    }

    func testWindowNumberAndOwnerPIDMismatchFailClosed() {
        XCTAssertNil(CaptureWindowValidator.mismatchReason(
            expectedNumber: 41, expectedOwnerPID: 900, actualNumber: 41, actualOwnerPID: 900
        ))
        XCTAssertEqual(
            CaptureWindowValidator.mismatchReason(
                expectedNumber: 41, expectedOwnerPID: 900, actualNumber: 42, actualOwnerPID: 900
            ),
            "window number changed from 41 to 42"
        )
        XCTAssertEqual(
            CaptureWindowValidator.mismatchReason(
                expectedNumber: 41, expectedOwnerPID: 900, actualNumber: 41, actualOwnerPID: 901
            ),
            "window owner PID changed from 900 to 901"
        )
    }

    func testBlackAndTransparentFramesAreRejectedButLightUniformDocumentsRemainUsable() throws {
        let width = 64
        let height = 64
        var black = [UInt8](repeating: 0, count: width * height * 4)
        for offset in stride(from: 3, to: black.count, by: 4) { black[offset] = 255 }
        // A single bright pixel should not make an otherwise black capture useful.
        black[0] = 255
        black[1] = 255
        black[2] = 255
        let blackQuality = try PixelQualityAnalyzer.analyzeRGBA(
            black, width: width, height: height, bytesPerRow: width * 4
        )
        XCTAssertFalse(blackQuality.usable)
        XCTAssertEqual(blackQuality.classification, "near-black")

        let transparent = [UInt8](repeating: 0, count: width * height * 4)
        let transparentQuality = try PixelQualityAnalyzer.analyzeRGBA(
            transparent, width: width, height: height, bytesPerRow: width * 4
        )
        XCTAssertFalse(transparentQuality.usable)
        XCTAssertEqual(transparentQuality.classification, "transparent")

        var gray = [UInt8](repeating: 128, count: width * height * 4)
        for offset in stride(from: 3, to: gray.count, by: 4) { gray[offset] = 255 }
        let grayQuality = try PixelQualityAnalyzer.analyzeRGBA(
            gray, width: width, height: height, bytesPerRow: width * 4
        )
        XCTAssertTrue(grayQuality.usable)
        XCTAssertEqual(grayQuality.classification, "near-uniform")

        var white = [UInt8](repeating: 255, count: width * height * 4)
        for offset in stride(from: 3, to: white.count, by: 4) { white[offset] = 255 }
        let whiteQuality = try PixelQualityAnalyzer.analyzeRGBA(
            white, width: width, height: height, bytesPerRow: width * 4
        )
        XCTAssertTrue(whiteQuality.usable)
        XCTAssertEqual(whiteQuality.classification, "near-white")
    }

    func testUniformDarkGrayCaptureIsRejectedAsNearBlack() throws {
        let width = 64
        let height = 64
        var darkGray = [UInt8](repeating: 28, count: width * height * 4)
        for offset in stride(from: 3, to: darkGray.count, by: 4) { darkGray[offset] = 255 }
        // A lone bright compositor pixel must not rescue an empty dark frame.
        darkGray[0] = 255
        darkGray[1] = 255
        darkGray[2] = 255
        let quality = try PixelQualityAnalyzer.analyzeRGBA(
            darkGray, width: width, height: height, bytesPerRow: width * 4
        )
        XCTAssertFalse(quality.usable)
        XCTAssertEqual(quality.classification, "near-black")
    }

    func testHighContrastContentIsUsable() throws {
        let width = 64
        let height = 64
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        for y in 0..<height {
            for x in 0..<width {
                let offset = (y * width + x) * 4
                let value: UInt8 = ((x / 8 + y / 8) % 2 == 0) ? 245 : 20
                pixels[offset] = value
                pixels[offset + 1] = value
                pixels[offset + 2] = value
                pixels[offset + 3] = 255
            }
        }
        let quality = try PixelQualityAnalyzer.analyzeRGBA(
            pixels, width: width, height: height, bytesPerRow: width * 4
        )
        XCTAssertTrue(quality.usable)
        XCTAssertEqual(quality.classification, "usable")
        XCTAssertGreaterThan(quality.luminanceVariance, 0.1)
    }
}
