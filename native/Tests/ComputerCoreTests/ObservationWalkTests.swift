import ApplicationServices
import XCTest
@testable import ComputerCore

final class ObservationWalkTests: XCTestCase {
    /// Distinct synthetic AXUIElement handles; attribute reads on them are
    /// never performed because every test injects its own child source.
    private func element(_ id: Int) -> AXUIElement {
        AXUIElementCreateApplication(pid_t(1_000 + id))
    }

    /// Builds a CFArray that RETAINS its elements.
    ///
    /// This passed `nil` for the callbacks, which means the array does not
    /// retain anything, and combined with `passUnretained` nothing kept the
    /// elements alive. AXUIElement arguments survived by accident — the tests
    /// hold them in locals — but a bridged temporary such as
    /// `"not-an-ax-element" as CFTypeRef` was deallocated the moment this
    /// function returned, leaving a dangling pointer that
    /// `ChildrenRead.from` then called `CFGetTypeID` on.
    ///
    /// That is a use-after-free, and it read as an environment quirk for three
    /// rounds: freed memory usually still looks like a valid object locally,
    /// while GitHub's macOS runner clobbered it and the test binary died with
    /// `error: Exited with unexpected signal code 5` — after every test that
    /// had run so far had passed.
    ///
    /// `kCFTypeArrayCallBacks` makes the array retain each element, which is
    /// what the tests assumed all along.
    private func cfArray(_ elements: [CFTypeRef]) -> CFArray {
        var pointers: [UnsafeRawPointer?] = elements.map { UnsafeRawPointer(Unmanaged.passUnretained($0).toOpaque()) }
        return pointers.withUnsafeMutableBufferPointer { buffer in
            withUnsafePointer(to: kCFTypeArrayCallBacks) { callbacks in
                CFArrayCreate(kCFAllocatorDefault, buffer.baseAddress, elements.count, callbacks)!
            }
        }
    }

    /// Child source over a synthetic tree: CFHash keys select each node's
    /// children; failing hashes simulate an AX children-attribute failure.
    private func tree(
        _ nodes: [CFHashCode: [AXUIElement]],
        failing: Set<CFHashCode> = []
    ) -> (AXUIElement) -> ChildrenRead {
        { element in
            let hash = CFHash(element)
            if failing.contains(hash) {
                return ChildrenRead(elements: [], complete: false)
            }
            return ChildrenRead(elements: nodes[hash] ?? [], complete: true)
        }
    }

    func testCompleteSmallTreeIsNotTruncated() {
        let root = element(1)
        let childA = element(2)
        let childB = element(3)
        let walk = ObservationWalk(maxDepth: 4, maxNodes: 200, children: tree([
            CFHash(root): [childA, childB],
        ]))
        let result = walk.walk(window: root)
        XCTAssertEqual(result.visited.count, 3)
        XCTAssertEqual(result.visited.map { CFHash($0.element) }, [CFHash(root), CFHash(childA), CFHash(childB)])
        XCTAssertFalse(result.truncated)
    }

    func testDepthLimitMarksTruncatedWhenChildrenExistBelowIt() {
        // C1: root -> child -> grandchild with maxDepth = 1. The grandchild
        // subtree is never inspected, so the result must be truncated.
        let root = element(1)
        let child = element(2)
        let grandchild = element(3)
        let walk = ObservationWalk(maxDepth: 1, maxNodes: 200, children: tree([
            CFHash(root): [child],
            CFHash(child): [grandchild],
        ]))
        let result = walk.walk(window: root)
        XCTAssertEqual(result.visited.count, 2, "root and child only")
        XCTAssertEqual(CFHash(result.visited[1].element), CFHash(child))
        XCTAssertTrue(result.truncated, "an unvisited grandchild exists but truncated is false")
    }

    func testDepthLimitDoesNotTruncateWhenBoundaryNodeIsALeaf() {
        let root = element(1)
        let child = element(2)
        let walk = ObservationWalk(maxDepth: 1, maxNodes: 200, children: tree([
            CFHash(root): [child],
        ]))
        let result = walk.walk(window: root)
        XCTAssertEqual(result.visited.count, 2)
        XCTAssertFalse(result.truncated, "no node exists below the depth limit")
    }

    func testChildCeilingClampIsAnIncompleteRead() {
        // C2: the production read interprets a raw 81-entry array through an
        // 80-child ceiling; the dropped entry must surface as incomplete.
        let children = (0..<81).map { element(10 + $0) as CFTypeRef }
        let read = ChildrenRead.from(raw: cfArray(children) as CFTypeRef, ceiling: 80)
        XCTAssertEqual(read.elements.count, 80)
        XCTAssertFalse(read.complete, "clamped children read must be incomplete")
    }

    func testWalkWithClampedChildSourceMarksTruncated() {
        // The traversal side of C2: 81 children clamped to 80 must produce a
        // truncated walk, never a silent 80-child completeness claim.
        let root = element(1)
        let children = (0..<81).map { element(10 + $0) }
        let source: (AXUIElement) -> ChildrenRead = { candidate in
            guard CFHash(candidate) == CFHash(root) else {
                return ChildrenRead(elements: [], complete: true)
            }
            return ChildrenRead(elements: Array(children.prefix(80)), complete: false)
        }
        let walk = ObservationWalk(maxDepth: 4, maxNodes: 200, children: source)
        let result = walk.walk(window: root)
        XCTAssertEqual(result.visited.count, 81, "root plus 80 emitted children")
        XCTAssertTrue(result.truncated)
    }

    func testAttributeFailureIsAnIncompleteRead() {
        // C3: a nil raw value (AX error) must not be mistaken for an empty
        // subtree.
        let read = ChildrenRead.from(raw: nil, ceiling: 80)
        XCTAssertTrue(read.elements.isEmpty)
        XCTAssertFalse(read.complete)
    }

    func testNonArrayChildrenValueIsAnIncompleteRead() {
        let bogus = "not-an-array" as CFString
        let read = ChildrenRead.from(raw: bogus as CFTypeRef, ceiling: 80)
        XCTAssertTrue(read.elements.isEmpty)
        XCTAssertFalse(read.complete)
    }

    func testNonAXArrayEntryIsAnIncompleteRead() {
        let root = element(1)
        let child = element(2)
        let read = ChildrenRead.from(
            raw: cfArray([root as CFTypeRef, "not-an-ax-element" as CFTypeRef, child as CFTypeRef]) as CFTypeRef,
            ceiling: 80
        )
        XCTAssertEqual(read.elements.count, 1)
        XCTAssertFalse(read.complete, "a non-AX entry hides a subtree")
    }

    func testWalkWithFailingChildrenSourceMarksTruncated() {
        // C3 traversal: a hidden child exists but the read fails; the walk
        // must report truncated instead of a provable absence.
        let root = element(1)
        let walk = ObservationWalk(
            maxDepth: 4, maxNodes: 200,
            children: tree([CFHash(root): [element(2)]], failing: [CFHash(root)])
        )
        let result = walk.walk(window: root)
        XCTAssertEqual(result.visited.count, 1)
        XCTAssertTrue(result.truncated)
    }

    func testNodeBudgetStillMarksTruncated() {
        let root = element(1)
        let walk = ObservationWalk(maxDepth: 4, maxNodes: 1, children: tree([
            CFHash(root): [element(2), element(3)],
        ]))
        let result = walk.walk(window: root)
        XCTAssertEqual(result.visited.count, 1)
        XCTAssertTrue(result.truncated)
    }
}
