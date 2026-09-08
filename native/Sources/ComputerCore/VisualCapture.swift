import CoreGraphics
import CoreText
import CryptoKit
import Darwin
import Foundation
import ImageIO

public struct VisualCaptureTarget: Equatable, Sendable {
    public let ref: String
    public let index: Int
    public let globalFrame: ComputerFrame

    public init(ref: String, index: Int, globalFrame: ComputerFrame) {
        self.ref = ref
        self.index = index
        self.globalFrame = globalFrame
    }
}

public struct VisualCaptureMark: Codable, Equatable, Sendable {
    public let number: Int
    public let ref: String
    public let index: Int
    public let pixelFrame: ComputerFrame

    public init(number: Int, ref: String, index: Int, pixelFrame: ComputerFrame) {
        self.number = number
        self.ref = ref
        self.index = index
        self.pixelFrame = pixelFrame
    }
}

public struct VisualCaptureQuality: Codable, Equatable, Sendable {
    public let classification: String
    public let usable: Bool
    public let sampleCount: Int
    public let visibleFraction: Double
    public let meanLuminance: Double
    public let luminanceVariance: Double
    public let luminanceRange: Double
    public let darkFraction: Double
    public let lightFraction: Double
    public let distinctColorBuckets: Int

    public init(
        classification: String,
        usable: Bool,
        sampleCount: Int,
        visibleFraction: Double,
        meanLuminance: Double,
        luminanceVariance: Double,
        luminanceRange: Double,
        darkFraction: Double,
        lightFraction: Double,
        distinctColorBuckets: Int
    ) {
        self.classification = classification
        self.usable = usable
        self.sampleCount = sampleCount
        self.visibleFraction = visibleFraction
        self.meanLuminance = meanLuminance
        self.luminanceVariance = luminanceVariance
        self.luminanceRange = luminanceRange
        self.darkFraction = darkFraction
        self.lightFraction = lightFraction
        self.distinctColorBuckets = distinctColorBuckets
    }
}

public struct VisualCaptureArtifact: Codable, Equatable, Sendable {
    public let format: String
    public let byteLength: Int
    public let sha256: String

    public init(format: String, byteLength: Int, sha256: String) {
        self.format = format
        self.byteLength = byteLength
        self.sha256 = sha256
    }
}

public struct VisualCaptureOutput: Codable, Equatable, Sendable {
    public let artifact: VisualCaptureArtifact
    public let pointFrame: ComputerFrame
    public let pixelWidth: Int
    public let pixelHeight: Int
    public let scaleX: Double
    public let scaleY: Double
    public let quality: VisualCaptureQuality
    public let marks: [VisualCaptureMark]

    public init(
        artifact: VisualCaptureArtifact,
        pointFrame: ComputerFrame,
        pixelWidth: Int,
        pixelHeight: Int,
        scaleX: Double,
        scaleY: Double,
        quality: VisualCaptureQuality,
        marks: [VisualCaptureMark]
    ) {
        self.artifact = artifact
        self.pointFrame = pointFrame
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
        self.scaleX = scaleX
        self.scaleY = scaleY
        self.quality = quality
        self.marks = marks
    }
}

public struct VisualCaptureFailure: Error, Equatable, Sendable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}

public enum CaptureWindowValidator {
    public static func mismatchReason(
        expectedNumber: Int,
        expectedOwnerPID: Int32,
        actualNumber: Int,
        actualOwnerPID: Int32
    ) -> String? {
        guard expectedNumber == actualNumber else {
            return "window number changed from \(expectedNumber) to \(actualNumber)"
        }
        guard expectedOwnerPID == actualOwnerPID else {
            return "window owner PID changed from \(expectedOwnerPID) to \(actualOwnerPID)"
        }
        return nil
    }
}

public struct CaptureCoordinateSpace: Equatable, Sendable {
    public let pointFrame: ComputerFrame
    public let pixelWidth: Int
    public let pixelHeight: Int
    public let scaleX: Double
    public let scaleY: Double

    public init(pointFrame: ComputerFrame, pixelWidth: Int, pixelHeight: Int) throws {
        guard pointFrame.x.isFinite, pointFrame.y.isFinite,
              pointFrame.width.isFinite, pointFrame.height.isFinite,
              pointFrame.width > 0, pointFrame.height > 0 else {
            throw VisualCaptureFailure(code: "invalid_window_frame", message: "window point frame must be finite and positive")
        }
        guard pixelWidth > 0, pixelHeight > 0, pixelWidth <= 65_535, pixelHeight <= 65_535 else {
            throw VisualCaptureFailure(code: "invalid_pixel_size", message: "window pixel dimensions are outside the supported range")
        }
        let x = Double(pixelWidth) / pointFrame.width
        let y = Double(pixelHeight) / pointFrame.height
        guard x.isFinite, y.isFinite, x > 0, y > 0 else {
            throw VisualCaptureFailure(code: "invalid_capture_scale", message: "window capture scale is not finite and positive")
        }
        self.pointFrame = pointFrame
        self.pixelWidth = pixelWidth
        self.pixelHeight = pixelHeight
        self.scaleX = x == 0 ? 0 : x
        self.scaleY = y == 0 ? 0 : y
    }

    /// Converts an Accessibility frame in global point coordinates into a clipped,
    /// top-origin pixel frame in the captured window image.
    public func pixelFrame(for globalFrame: ComputerFrame) -> ComputerFrame? {
        guard globalFrame.x.isFinite, globalFrame.y.isFinite,
              globalFrame.width.isFinite, globalFrame.height.isFinite,
              globalFrame.width > 0, globalFrame.height > 0 else { return nil }

        let pointMinX = max(pointFrame.x, globalFrame.x)
        let pointMinY = max(pointFrame.y, globalFrame.y)
        let pointMaxX = min(pointFrame.x + pointFrame.width, globalFrame.x + globalFrame.width)
        let pointMaxY = min(pointFrame.y + pointFrame.height, globalFrame.y + globalFrame.height)
        guard pointMaxX > pointMinX, pointMaxY > pointMinY else { return nil }

        let rawMinX = floor((pointMinX - pointFrame.x) * scaleX)
        let rawMinY = floor((pointMinY - pointFrame.y) * scaleY)
        let rawMaxX = ceil((pointMaxX - pointFrame.x) * scaleX)
        let rawMaxY = ceil((pointMaxY - pointFrame.y) * scaleY)
        let minX = max(0, min(Double(pixelWidth), rawMinX))
        let minY = max(0, min(Double(pixelHeight), rawMinY))
        let maxX = max(0, min(Double(pixelWidth), rawMaxX))
        let maxY = max(0, min(Double(pixelHeight), rawMaxY))
        guard maxX > minX, maxY > minY else { return nil }
        return ComputerFrame(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
    }
}

public enum PixelQualityAnalyzer {
    private static let maximumSampleSide = 64

    public static func analyze(image: CGImage) throws -> VisualCaptureQuality {
        let width = min(maximumSampleSide, max(1, image.width))
        let height = min(maximumSampleSide, max(1, image.height))
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        guard let context = CGContext(
            data: &bytes,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
        ) else {
            throw VisualCaptureFailure(code: "pixel_analysis_failed", message: "could not allocate the screenshot sampling context")
        }
        context.interpolationQuality = .low
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return try analyzeRGBA(bytes, width: width, height: height, bytesPerRow: width * 4)
    }

    public static func analyzeRGBA(
        _ bytes: [UInt8],
        width: Int,
        height: Int,
        bytesPerRow: Int
    ) throws -> VisualCaptureQuality {
        guard width > 0, height > 0, bytesPerRow >= width * 4,
              bytes.count >= bytesPerRow * height else {
            throw VisualCaptureFailure(code: "invalid_pixel_buffer", message: "RGBA sample buffer dimensions are inconsistent")
        }
        let total = width * height
        var visible = 0
        var sum = 0.0
        var sumSquares = 0.0
        var minimum = 1.0
        var maximum = 0.0
        var dark = 0
        var light = 0
        var buckets = Set<Int>()

        for y in 0..<height {
            for x in 0..<width {
                let offset = y * bytesPerRow + x * 4
                let alpha = Int(bytes[offset + 3])
                guard alpha >= 16 else { continue }
                visible += 1
                let red = Double(bytes[offset]) / 255.0
                let green = Double(bytes[offset + 1]) / 255.0
                let blue = Double(bytes[offset + 2]) / 255.0
                let luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue
                sum += luminance
                sumSquares += luminance * luminance
                minimum = min(minimum, luminance)
                maximum = max(maximum, luminance)
                if luminance <= 0.04 { dark += 1 }
                if luminance >= 0.96 { light += 1 }
                buckets.insert((Int(bytes[offset]) >> 5) << 6 | (Int(bytes[offset + 1]) >> 5) << 3 | (Int(bytes[offset + 2]) >> 5))
            }
        }

        let visibleFraction = Double(visible) / Double(total)
        guard visible > 0 else {
            return VisualCaptureQuality(
                classification: "transparent", usable: false, sampleCount: total,
                visibleFraction: visibleFraction, meanLuminance: 0, luminanceVariance: 0,
                luminanceRange: 0, darkFraction: 0, lightFraction: 0, distinctColorBuckets: 0
            )
        }
        let count = Double(visible)
        let mean = sum / count
        let variance = max(0, sumSquares / count - mean * mean)
        let range = max(0, maximum - minimum)
        let darkFraction = Double(dark) / count
        let lightFraction = Double(light) / count
        // Permission failures and compositor glitches are not always literal
        // #000000. Catch nearly solid dark-gray frames too, while allowing a
        // genuine dark UI once it has meaningful luminance variation.
        let nearlyPureBlack = darkFraction >= 0.995 && variance <= 0.0005
        let lowMeanDarkFrame = mean <= 0.16 && (variance <= 0.001 || range <= 0.12)
        let nearBlack = nearlyPureBlack || lowMeanDarkFrame
        let nearWhite = lightFraction >= 0.995 && variance <= 0.0005
        let nearUniform = variance <= 0.0004 && range <= 0.08 && buckets.count <= 4
        let mostlyTransparent = visibleFraction < 0.02
        let classification: String
        if mostlyTransparent { classification = "mostly-transparent" }
        else if nearBlack { classification = "near-black" }
        else if nearWhite { classification = "near-white" }
        else if nearUniform { classification = "near-uniform" }
        else { classification = "usable" }
        return VisualCaptureQuality(
            classification: classification,
            // A white canvas or a uniform light document can be completely
            // legitimate. Preserve the warning classification, but hard-fail
            // only captures that carry no pixels or look like a dark capture
            // failure.
            usable: classification != "mostly-transparent" && classification != "near-black",
            sampleCount: total,
            visibleFraction: visibleFraction,
            meanLuminance: mean,
            luminanceVariance: variance,
            luminanceRange: range,
            darkFraction: darkFraction,
            lightFraction: lightFraction,
            distinctColorBuckets: buckets.count
        )
    }
}

public enum WindowCaptureEngine {
    private struct WindowMetadata {
        let number: Int
        let ownerPID: Int32
        let pointFrame: ComputerFrame
    }

    /// Deadline for the modern ScreenCaptureKit path. The old CGWindowList path
    /// remains synchronous and did not previously expose a timeout.
    private static let modernCaptureTimeout: TimeInterval = 5.0

    public static func screenRecordingPreflight() -> Bool {
        CGPreflightScreenCaptureAccess()
    }

    public static func capture(
        windowNumber: Int,
        ownerPID: Int32,
        expectedPointFrame: ComputerFrame,
        targets: [VisualCaptureTarget],
        outputPath: String
    ) async throws -> VisualCaptureOutput {
        guard screenRecordingPreflight() else {
            throw VisualCaptureFailure(
                code: "screen_recording_permission_required",
                message: "Screen Recording permission is not granted to this DSH Computer Helper process"
            )
        }
        guard let windowID = CGWindowID(exactly: windowNumber), windowID != 0 else {
            throw VisualCaptureFailure(code: "invalid_window_number", message: "capture requires a positive UInt32 window number")
        }
        let metadata = try windowMetadata(windowID: windowID)
        if let reason = CaptureWindowValidator.mismatchReason(
            expectedNumber: windowNumber,
            expectedOwnerPID: ownerPID,
            actualNumber: metadata.number,
            actualOwnerPID: metadata.ownerPID
        ) {
            throw VisualCaptureFailure(code: "window_id_mismatch", message: reason)
        }
        guard expectedPointFrame.approximatelyEquals(metadata.pointFrame, tolerance: 2.0) else {
            throw VisualCaptureFailure(
                code: "window_bounds_mismatch",
                message: "Accessibility and CoreGraphics window bounds disagree; refusing unsafe overlay coordinates"
            )
        }

        let image: CGImage
        if #available(macOS 14.0, *) {
            do {
                image = try await SCKWindowCapture.capture(
                    windowID: windowID,
                    ownerPID: ownerPID,
                    expectedFrame: CGRect(
                        x: metadata.pointFrame.x,
                        y: metadata.pointFrame.y,
                        width: metadata.pointFrame.width,
                        height: metadata.pointFrame.height
                    ),
                    timeout: modernCaptureTimeout
                )
            } catch {
                // Modern errors must not silently fall back to a stale or less
                // stable CGWindowList image.
                throw visualFailure(error)
            }
        } else {
            guard let cgImage = CGWindowListCreateImage(
                .null,
                .optionIncludingWindow,
                windowID,
                [.boundsIgnoreFraming, .bestResolution]
            ) else {
                throw VisualCaptureFailure(
                    code: "window_capture_failed",
                    message: "CoreGraphics returned no image for the validated window while Screen Recording preflight was granted"
                )
            }
            image = cgImage
        }

        return try finishCapture(
            image: image,
            metadata: metadata,
            targets: targets,
            outputPath: outputPath
        )
    }

    private static func finishCapture(
        image: CGImage,
        metadata: WindowMetadata,
        targets: [VisualCaptureTarget],
        outputPath: String
    ) throws -> VisualCaptureOutput {
        let quality = try PixelQualityAnalyzer.analyze(image: image)
        guard quality.usable else {
            throw VisualCaptureFailure(
                code: "capture_unusable",
                message: "captured window pixels were \(quality.classification) (visible=\(quality.visibleFraction), variance=\(quality.luminanceVariance))"
            )
        }
        let coordinates = try CaptureCoordinateSpace(
            pointFrame: metadata.pointFrame,
            pixelWidth: image.width,
            pixelHeight: image.height
        )
        var marks: [VisualCaptureMark] = []
        marks.reserveCapacity(targets.count)
        for target in targets {
            guard let pixelFrame = coordinates.pixelFrame(for: target.globalFrame) else { continue }
            marks.append(VisualCaptureMark(
                number: marks.count + 1,
                ref: target.ref,
                index: target.index,
                pixelFrame: pixelFrame
            ))
        }
        let rendered = try renderOverlay(image: image, marks: marks, coordinateSpace: coordinates)
        let png = try encodePNG(rendered)
        guard png.count <= 64 * 1024 * 1024 else {
            throw VisualCaptureFailure(code: "capture_too_large", message: "encoded screenshot exceeds the 64 MiB safety limit")
        }
        try writeSecurely(png, requestedPath: outputPath)
        let digest = SHA256.hash(data: png).map { String(format: "%02x", $0) }.joined()
        return VisualCaptureOutput(
            artifact: VisualCaptureArtifact(format: "png", byteLength: png.count, sha256: digest),
            pointFrame: metadata.pointFrame,
            pixelWidth: image.width,
            pixelHeight: image.height,
            scaleX: coordinates.scaleX,
            scaleY: coordinates.scaleY,
            quality: quality,
            marks: marks
        )
    }

    private static func visualFailure(_ error: Error) -> VisualCaptureFailure {
        if let failure = error as? VisualCaptureFailure {
            return failure
        }
        guard let captureError = error as? SCKCaptureError else {
            return VisualCaptureFailure(code: "window_capture_failed", message: String(describing: error))
        }
        switch captureError {
        case .invalidWindowID:
            return VisualCaptureFailure(code: "invalid_window_number", message: captureError.debugDescription)
        case .invalidOwnerPID:
            return VisualCaptureFailure(code: "window_owner_mismatch", message: captureError.debugDescription)
        case .invalidExpectedFrame:
            return VisualCaptureFailure(code: "invalid_window_frame", message: captureError.debugDescription)
        case .permissionDenied:
            return VisualCaptureFailure(code: "screen_recording_permission_required", message: captureError.debugDescription)
        case .windowNotFound, .windowAmbiguous, .windowIDMismatch, .windowOwnerMismatch:
            return VisualCaptureFailure(code: "window_id_mismatch", message: captureError.debugDescription)
        case .windowBoundsMismatch:
            return VisualCaptureFailure(code: "window_bounds_mismatch", message: captureError.debugDescription)
        case .contentUnavailable, .unsafePixelDimensions, .returnedDimensionMismatch, .timedOut, .captureFailed:
            return VisualCaptureFailure(code: "window_capture_failed", message: captureError.debugDescription)
        }
    }

    private static func windowMetadata(windowID: CGWindowID) throws -> WindowMetadata {
        guard let records = CGWindowListCopyWindowInfo(.optionIncludingWindow, windowID) as? [[String: Any]],
              let record = records.first(where: {
                  ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == windowID
              }),
              let number = (record[kCGWindowNumber as String] as? NSNumber)?.intValue,
              let ownerPIDNumber = record[kCGWindowOwnerPID as String] as? NSNumber,
              let boundsDictionary = record[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: boundsDictionary as CFDictionary),
              bounds.origin.x.isFinite, bounds.origin.y.isFinite,
              bounds.width.isFinite, bounds.height.isFinite,
              bounds.width > 0, bounds.height > 0 else {
            throw VisualCaptureFailure(
                code: "window_not_capturable",
                message: "CoreGraphics did not expose metadata for the explicit window number"
            )
        }
        return WindowMetadata(
            number: number,
            ownerPID: ownerPIDNumber.int32Value,
            pointFrame: ComputerFrame(x: bounds.origin.x, y: bounds.origin.y, width: bounds.width, height: bounds.height)
        )
    }

    private static func renderOverlay(
        image: CGImage,
        marks: [VisualCaptureMark],
        coordinateSpace: CaptureCoordinateSpace
    ) throws -> CGImage {
        guard let context = CGContext(
            data: nil,
            width: image.width,
            height: image.height,
            bitsPerComponent: 8,
            bytesPerRow: image.width * 4,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
        ) else {
            throw VisualCaptureFailure(code: "overlay_failed", message: "could not allocate the screenshot overlay context")
        }
        context.interpolationQuality = .none
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        let density = max(coordinateSpace.scaleX, coordinateSpace.scaleY)
        let lineWidth = max(2.0, min(5.0, 1.5 * density))
        let badgeDiameter = max(20.0, min(42.0, 18.0 * density))
        let red = CGColor(red: 0.94, green: 0.12, blue: 0.14, alpha: 0.96)
        let white = CGColor(red: 1, green: 1, blue: 1, alpha: 1)
        context.setLineWidth(lineWidth)
        context.setStrokeColor(red)

        for mark in marks {
            let topFrame = mark.pixelFrame
            let drawingFrame = CGRect(
                x: topFrame.x,
                y: Double(image.height) - topFrame.y - topFrame.height,
                width: topFrame.width,
                height: topFrame.height
            )
            context.stroke(drawingFrame.insetBy(dx: lineWidth / 2, dy: lineWidth / 2))
            let centerX = max(badgeDiameter / 2, min(Double(image.width) - badgeDiameter / 2, drawingFrame.minX + badgeDiameter / 2))
            let centerY = max(badgeDiameter / 2, min(Double(image.height) - badgeDiameter / 2, drawingFrame.maxY - badgeDiameter / 2))
            let badge = CGRect(
                x: centerX - badgeDiameter / 2,
                y: centerY - badgeDiameter / 2,
                width: badgeDiameter,
                height: badgeDiameter
            )
            context.setFillColor(red)
            context.fillEllipse(in: badge)

            let font = CTFontCreateWithName("Helvetica-Bold" as CFString, badgeDiameter * 0.56, nil)
            let attributes: [CFString: Any] = [
                kCTFontAttributeName: font,
                kCTForegroundColorAttributeName: white,
            ]
            guard let attributed = CFAttributedStringCreate(
                nil,
                String(mark.number) as CFString,
                attributes as CFDictionary
            ) else { continue }
            let line = CTLineCreateWithAttributedString(attributed)
            let bounds = CTLineGetBoundsWithOptions(line, [.useGlyphPathBounds])
            context.textMatrix = .identity
            context.textPosition = CGPoint(
                x: badge.midX - bounds.midX,
                y: badge.midY - bounds.midY
            )
            CTLineDraw(line, context)
        }
        guard let result = context.makeImage() else {
            throw VisualCaptureFailure(code: "overlay_failed", message: "could not finalize the screenshot overlay")
        }
        return result
    }

    private static func encodePNG(_ image: CGImage) throws -> Data {
        let bytes = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(bytes, "public.png" as CFString, 1, nil) else {
            throw VisualCaptureFailure(code: "png_encode_failed", message: "could not create a PNG encoder")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw VisualCaptureFailure(code: "png_encode_failed", message: "could not finalize the PNG screenshot")
        }
        return bytes as Data
    }

    private static func writeSecurely(_ data: Data, requestedPath: String) throws {
        let requested = URL(fileURLWithPath: requestedPath).standardizedFileURL
        guard requested.lastPathComponent == "capture.png" else {
            throw VisualCaptureFailure(code: "unsafe_capture_path", message: "capture output must use the fixed capture.png filename")
        }
        let originalParent = requested.deletingLastPathComponent()
        var originalParentStat = stat()
        guard lstat(originalParent.path, &originalParentStat) == 0,
              originalParentStat.st_mode & S_IFMT == S_IFDIR,
              originalParentStat.st_uid == geteuid(),
              originalParentStat.st_mode & 0o077 == 0,
              originalParent.lastPathComponent.hasPrefix("dsh-computer-capture-") else {
            throw VisualCaptureFailure(
                code: "unsafe_capture_path",
                message: "capture output parent must be a caller-owned mode-0700 temporary directory"
            )
        }
        let temporaryRoot = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().standardizedFileURL.path
        let resolvedParent = originalParent.resolvingSymlinksInPath().standardizedFileURL
        guard resolvedParent.path.hasPrefix(temporaryRoot + "/") else {
            throw VisualCaptureFailure(code: "unsafe_capture_path", message: "capture output is outside the system temporary directory")
        }
        let output = resolvedParent.appendingPathComponent("capture.png", isDirectory: false)
        var existing = stat()
        guard lstat(output.path, &existing) != 0, errno == ENOENT else {
            throw VisualCaptureFailure(code: "unsafe_capture_path", message: "capture output already exists or cannot be inspected")
        }

        let descriptor = open(output.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else {
            throw VisualCaptureFailure(code: "capture_write_failed", message: "could not create the protected PNG output")
        }
        var completed = false
        defer {
            close(descriptor)
            if !completed { unlink(output.path) }
        }
        try data.withUnsafeBytes { rawBuffer in
            guard let base = rawBuffer.baseAddress else { return }
            var offset = 0
            while offset < rawBuffer.count {
                let written = Darwin.write(descriptor, base.advanced(by: offset), rawBuffer.count - offset)
                if written < 0 {
                    if errno == EINTR { continue }
                    throw VisualCaptureFailure(code: "capture_write_failed", message: "failed while writing the protected PNG output")
                }
                guard written > 0 else {
                    throw VisualCaptureFailure(code: "capture_write_failed", message: "PNG output write made no progress")
                }
                offset += written
            }
        }
        guard fsync(descriptor) == 0 else {
            throw VisualCaptureFailure(code: "capture_write_failed", message: "could not flush the protected PNG output")
        }
        completed = true
    }
}
