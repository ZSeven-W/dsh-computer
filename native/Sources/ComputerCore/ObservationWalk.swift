@preconcurrency import ApplicationServices
import Foundation

/// One complete-or-incomplete Accessibility children-attribute read.
/// complete is true only when the read provably saw every child: the AX
/// attribute call succeeded, the value was an array, every array entry was an
/// AX element, and nothing was dropped by a per-node ceiling. Any other
/// outcome means an AX node may exist that was not emitted, and observation
/// consumers must be told via the truncated flag.
public struct ChildrenRead: Sendable {
    public let elements: [AXUIElement]
    public let complete: Bool

    public init(elements: [AXUIElement], complete: Bool) {
        self.elements = elements
        self.complete = complete
    }

    /// Interprets a raw children read. A nil raw value (AX failure), a
    /// non-array value, a clamped array, or a non-AX entry inside the array
    /// all make the read incomplete, because each hides a subtree the walk
    /// will not visit.
    public static func from(raw: CFTypeRef?, ceiling: Int) -> ChildrenRead {
        guard let raw, CFGetTypeID(raw) == CFArrayGetTypeID() else {
            return ChildrenRead(elements: [], complete: false)
        }
        let array = raw as! CFArray
        let total = CFArrayGetCount(array)
        let count = min(total, max(0, ceiling))
        var elements: [AXUIElement] = []
        elements.reserveCapacity(count)
        for index in 0..<count {
            let rawEntry = CFArrayGetValueAtIndex(array, index)
            let entry = unsafeBitCast(rawEntry, to: CFTypeRef.self)
            guard CFGetTypeID(entry) == AXUIElementGetTypeID() else {
                return ChildrenRead(elements: elements, complete: false)
            }
            elements.append(unsafeDowncast(entry, to: AXUIElement.self))
        }
        return ChildrenRead(elements: elements, complete: count == total)
    }
}

/// One element the observation walk visited, with its traversal locator.
public struct WalkedElement: Sendable {
    public let element: AXUIElement
    public let locator: [Int]
    public let depth: Int

    public init(element: AXUIElement, locator: [Int], depth: Int) {
        self.element = element
        self.locator = locator
        self.depth = depth
    }
}

public struct ObservationWalkResult: Sendable {
    public let visited: [WalkedElement]
    /// True whenever ANY AX node that exists in the tree was not emitted:
    /// depth limit with a non-empty subtree below it, an incomplete children
    /// read, the node budget, or the queue budget.
    public let truncated: Bool

    public init(visited: [WalkedElement], truncated: Bool) {
        self.visited = visited
        self.truncated = truncated
    }
}

/// Bounded breadth-first AX tree walk with an injectable child source, so the
/// truncation contract can be exercised against synthetic trees in unit tests.
/// The walk itself never calls into the live AX API: production supplies
/// children as a real kAXChildrenAttribute read.
public struct ObservationWalk {
    public let maxDepth: Int
    public let maxNodes: Int
    public let children: (AXUIElement) -> ChildrenRead

    public init(
        maxDepth: Int,
        maxNodes: Int,
        children: @escaping (AXUIElement) -> ChildrenRead
    ) {
        self.maxDepth = maxDepth
        self.maxNodes = maxNodes
        self.children = children
    }

    public func walk(window: AXUIElement) -> ObservationWalkResult {
        var queue: [(AXUIElement, [Int], Int)] = [(window, [], 0)]
        var index = 0
        var visited: [WalkedElement] = []
        var seen = Set<CFHashCode>()
        var truncated = false

        while index < queue.count && visited.count < maxNodes {
            let (element, locator, depth) = queue[index]
            index += 1
            let hash = CFHash(element)
            if seen.contains(hash) { continue }
            seen.insert(hash)
            visited.append(WalkedElement(element: element, locator: locator, depth: depth))
            let read = children(element)
            if !read.complete {
                // A failed, clamped, or partially-unreadable children read can
                // hide nodes: absence below this element cannot be proven.
                truncated = true
            }
            if depth >= maxDepth {
                // The subtree below the depth limit is never inspected. If the
                // element has children, nodes exist that were not emitted.
                if !read.elements.isEmpty { truncated = true }
                continue
            }
            for (childIndex, child) in read.elements.enumerated() {
                if queue.count >= maxNodes * 2 {
                    truncated = true
                    break
                }
                queue.append((child, locator + [childIndex], depth + 1))
            }
        }
        if index < queue.count { truncated = true }
        return ObservationWalkResult(visited: visited, truncated: truncated)
    }
}
