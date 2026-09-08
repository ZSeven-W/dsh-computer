import CryptoKit
import Foundation

/// Native-image pixel coordinate inside a captured window image.
public struct NativeVisualPoint: Codable, Equatable, Sendable {
    public let x: Int
    public let y: Int

    public init(x: Int, y: Int) {
        self.x = x
        self.y = y
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let xNumber = try container.decode(Double.self, forKey: .x)
        let yNumber = try container.decode(Double.self, forKey: .y)
        guard xNumber.isFinite, xNumber.rounded() == xNumber,
              yNumber.isFinite, yNumber.rounded() == yNumber,
              xNumber >= Double(Int.min), xNumber <= Double(Int.max),
              yNumber >= Double(Int.min), yNumber <= Double(Int.max) else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(
                    codingPath: container.codingPath,
                    debugDescription: "visual point coordinates must be integers"
                )
            )
        }
        self.x = Int(xNumber)
        self.y = Int(yNumber)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(x, forKey: .x)
        try container.encode(y, forKey: .y)
    }

    private enum CodingKeys: String, CodingKey {
        case x, y
    }
}

/// A visual action in native-image pixels, matching NativeVisualActionPayload.
public struct NativeVisualActionPayload: Codable, Equatable, Sendable {
    public let op: String
    public let point: NativeVisualPoint
    public let to: NativeVisualPoint?
    public let direction: String?
    public let amount: ScrollAmount?

    public init(
        op: String,
        point: NativeVisualPoint,
        to: NativeVisualPoint? = nil,
        direction: String? = nil,
        amount: ScrollAmount? = nil
    ) {
        self.op = op
        self.point = point
        self.to = to
        self.direction = direction
        self.amount = amount
    }

    private enum CodingKeys: String, CodingKey {
        case op, point, to, direction, amount
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(op, forKey: .op)
        try container.encode(point, forKey: .point)
        try container.encode(to, forKey: .to)
        try container.encode(direction, forKey: .direction)
        try container.encode(amount, forKey: .amount)
    }
}

public struct VisualGlobalPoint: Equatable, Sendable {
    public let x: Double
    public let y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

public enum VisualActionPathValidator {
    public static func failure(
        action: NativeVisualActionPayload,
        pixelWidth: Int,
        pixelHeight: Int
    ) -> String? {
        guard pixelWidth > 0, pixelHeight > 0 else {
            return "visual capture pixel dimensions must be positive"
        }
        guard action.op == "click" || action.op == "drag" || action.op == "scroll" else {
            return "unsupported visual action op: \(action.op)"
        }
        if let reason = pointFailure(action.point, pixelWidth: pixelWidth, pixelHeight: pixelHeight, label: "point") {
            return reason
        }
        switch action.op {
        case "click":
            if action.to != nil || action.direction != nil || action.amount != nil {
                return "click does not accept drag or scroll fields"
            }
        case "drag":
            guard let to = action.to else { return "drag requires a destination point" }
            if action.direction != nil || action.amount != nil {
                return "drag does not accept scroll fields"
            }
            if let reason = pointFailure(to, pixelWidth: pixelWidth, pixelHeight: pixelHeight, label: "drag endpoint") {
                return reason
            }
        case "scroll":
            if action.to != nil {
                return "scroll does not accept a drag destination"
            }
            guard action.direction == "up" || action.direction == "down" else {
                return "scroll direction must be up or down"
            }
        default:
            break
        }
        return nil
    }

    private static func pointFailure(
        _ point: NativeVisualPoint,
        pixelWidth: Int,
        pixelHeight: Int,
        label: String
    ) -> String? {
        guard point.x >= 0, point.y >= 0,
              point.x < pixelWidth, point.y < pixelHeight else {
            return "\(label) is outside the captured window bounds"
        }
        return nil
    }
}

public enum VisualCoordinateMapper {
    public static func globalPoint(
        native point: NativeVisualPoint,
        pointFrame: ComputerFrame,
        scaleX: Double,
        scaleY: Double,
        pixelWidth: Int,
        pixelHeight: Int
    ) -> VisualGlobalPoint? {
        guard pointFrame.x.isFinite, pointFrame.y.isFinite,
              pointFrame.width.isFinite, pointFrame.height.isFinite,
              pointFrame.width > 0, pointFrame.height > 0,
              scaleX.isFinite, scaleY.isFinite,
              scaleX > 0, scaleY > 0,
              pixelWidth > 0, pixelHeight > 0,
              point.x >= 0, point.y >= 0,
              point.x < pixelWidth, point.y < pixelHeight else {
            return nil
        }
        let globalX = pointFrame.x + Double(point.x) / scaleX
        let globalY = pointFrame.y + Double(point.y) / scaleY
        guard globalX.isFinite, globalY.isFinite else { return nil }
        return VisualGlobalPoint(x: globalX, y: globalY)
    }
}

/// Conservative proof that a system-wide Accessibility point hit belongs to
/// the same live window and process that a visual action targets.
///
/// This is deliberately generic: production feeds it AXUIElement objects and
/// platform attribute readers, while tests can feed it lightweight fake
/// elements to exercise the bounded traversal/failure modes without launching
/// user applications.
public enum VisualPointHitProof {
    /// Resolve an AX hit to the exact expected window, or fail closed.
    ///
    /// The hit itself may be an AXWindow whose AXWindow attribute is
    /// unsupported; it may also be a descendant that exposes either AXWindow
    /// or a bounded parent chain. Any unknown PID, different PID, different
    /// window, unreadable attribute, or cycle/traversal overrun rejects.
    public static func resolvesToExpectedWindow<Element>(
        from hit: Element,
        expectedPID: Int32,
        expectedWindow: Element,
        elementPID: (Element) -> Int32?,
        windowAttribute: (Element) -> Element?,
        parentAttribute: (Element) -> Element?,
        elementsEqual: (Element, Element) -> Bool,
        maxTraversalNodes: Int = 24
    ) -> Bool {
        guard let hitPID = elementPID(hit), hitPID == expectedPID else {
            return false
        }

        var pending: [Element] = [hit]
        var visited: [Element] = []

        while let node = pending.first {
            pending.removeFirst()
            if visited.contains(where: { elementsEqual($0, node) }) {
                continue
            }
            visited.append(node)
            if visited.count > maxTraversalNodes {
                return false
            }
            guard let pid = elementPID(node), pid == expectedPID else {
                return false
            }
            if elementsEqual(node, expectedWindow) {
                return true
            }
            if let window = windowAttribute(node) {
                guard let windowPID = elementPID(window), windowPID == expectedPID else {
                    return false
                }
                if elementsEqual(window, expectedWindow) {
                    return true
                }
                if !elementsEqual(window, node) {
                    pending.append(window)
                }
            }
            if let parent = parentAttribute(node) {
                pending.append(parent)
            }
        }
        return false
    }
}

/// Cross-language visual action approval digest. Must stay in lockstep with
/// the TypeScript normalizedVisualActionDigest in src/controller.ts.
public enum VisualActionApprovalBinding {
    private static let version = "dsh-computer-visual-action-v1"

    public static func digest(
        captureSha256: String,
        action: NativeVisualActionPayload,
        window: WindowIdentity
    ) -> String? {
        guard let windowNumber = window.number else { return nil }
        var components: [String] = [
            version,
            action.op,
            captureSha256,
            String(action.point.x),
            String(action.point.y),
        ]
        switch action.op {
        case "click":
            break
        case "drag":
            guard let to = action.to else { return nil }
            components.append(String(to.x))
            components.append(String(to.y))
        case "scroll":
            guard let direction = action.direction,
                  direction == "up" || direction == "down" else { return nil }
            components.append(direction)
            components.append(scrollAmountCanonical(action.amount ?? .page))
        default:
            return nil
        }
        components.append(String(windowNumber))
        components.append(window.identity)
        let canonical = components
            .map { "\($0.utf8.count):\($0)" }
            .joined(separator: "|")
        return SHA256.hash(data: Data(canonical.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    private static func scrollAmountCanonical(_ amount: ScrollAmount) -> String {
        switch amount {
        case .line:
            return "line"
        case .page:
            return "page"
        case .points(let value):
            let cents = Int((value * 100).rounded())
            let fraction = abs(cents % 100)
            let fractionText = fraction < 10 ? "0\(fraction)" : "\(fraction)"
            return "\(cents / 100).\(fractionText)"
        }
    }
}

/// Native enforcement for visual-point actions. Every visual action is
/// ungrounded and therefore always requires an allowed-once host grant.
public enum VisualActionPolicy {
    public static func rejection(
        captureSha256: String,
        action: NativeVisualActionPayload,
        window: WindowIdentity,
        approval: HostApprovalGrant?
    ) -> String? {
        guard let approval else {
            return "coordinate-based visual action requires one-action host approval"
        }
        guard approval.riskCode == .visualPointAction else {
            return "host approval grant does not match this visual action"
        }
        guard let digest = VisualActionApprovalBinding.digest(
            captureSha256: captureSha256,
            action: action,
            window: window
        ), digest == approval.actionDigest else {
            return "host approval grant does not match this visual action"
        }
        return nil
    }
}
