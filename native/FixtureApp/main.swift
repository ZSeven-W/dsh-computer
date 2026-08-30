import AppKit

private let rowCount = 100
private let targetRow = 57

final class AppDelegate: NSObject, NSApplicationDelegate, NSTableViewDataSource, NSTableViewDelegate {
    private var window: NSWindow!
    private var statusLabel: NSTextField!
    private var publishedLabel: NSTextField!
    private var publishButton: NSButton!
    private var publishCount = 0

    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 500, height: 460),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Fixture Window"
        window.isReleasedWhenClosed = false

        let content = NSView(frame: NSRect(x: 0, y: 0, width: 500, height: 460))

        let statusLabel = NSTextField(labelWithString: "Status: idle")
        statusLabel.identifier = NSUserInterfaceItemIdentifier("status-label")
        statusLabel.setAccessibilityIdentifier("status-label")
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(statusLabel)

        let publishedLabel = NSTextField(labelWithString: "PUBLISHED: 0")
        publishedLabel.identifier = NSUserInterfaceItemIdentifier("published-count")
        publishedLabel.setAccessibilityIdentifier("published-count")
        publishedLabel.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(publishedLabel)

        let publishButton = NSButton(title: "Publish release", target: self, action: #selector(publishClicked(_:)))
        publishButton.bezelStyle = .rounded
        publishButton.setAccessibilityIdentifier("publish-release")
        publishButton.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(publishButton)

        let scrollView = NSScrollView(frame: NSRect(x: 16, y: 16, width: 468, height: 370))
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = false
        scrollView.borderType = .bezelBorder
        scrollView.translatesAutoresizingMaskIntoConstraints = false

        let table = NSTableView(frame: scrollView.bounds)
        table.headerView = nil
        table.rowHeight = 28
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.action = #selector(tableClicked(_:))
        table.setAccessibilityIdentifier("row-list")
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("column"))
        column.width = 460
        table.addTableColumn(column)
        scrollView.documentView = table

        content.addSubview(scrollView)
        window.contentView = content

        NSLayoutConstraint.activate([
            publishedLabel.topAnchor.constraint(equalTo: content.topAnchor, constant: 14),
            publishedLabel.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16),
            publishButton.centerYAnchor.constraint(equalTo: publishedLabel.centerYAnchor),
            publishButton.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -16),
            statusLabel.topAnchor.constraint(equalTo: publishedLabel.bottomAnchor, constant: 10),
            statusLabel.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16),
            scrollView.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 10),
            scrollView.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16),
            scrollView.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -16),
            scrollView.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -16),
        ])

        self.window = window
        self.statusLabel = statusLabel
        self.publishedLabel = publishedLabel
        self.publishButton = publishButton
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func numberOfRows(in tableView: NSTableView) -> Int { rowCount }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let identifier = NSUserInterfaceItemIdentifier("row-cell")
        let button = tableView.makeView(withIdentifier: identifier, owner: nil) as? NSButton ?? {
            let created = NSButton(frame: NSRect(x: 0, y: 0, width: 460, height: 26))
            created.identifier = identifier
            created.isBordered = false
            created.alignment = .left
            created.target = self
            created.action = #selector(rowClicked(_:))
            return created
        }()
        button.title = row == targetRow ? "Target Row \(row)" : "Row \(row)"
        button.tag = row
        button.setAccessibilityIdentifier("row-\(row)")
        return button
    }

    @objc private func rowClicked(_ sender: NSButton) {
        guard sender.tag == targetRow else { return }
        statusLabel.stringValue = "Status: clicked"
    }

    @objc private func publishClicked(_ sender: NSButton) {
        publishCount += 1
        publishedLabel.stringValue = "PUBLISHED: \(publishCount)"
    }

    @objc private func tableClicked(_ sender: NSTableView) {
        // Fallback path; the primary click path is the row button action above.
        let row = sender.clickedRow
        guard row == targetRow else { return }
        statusLabel.stringValue = "Status: clicked"
    }
}

let delegate = AppDelegate()
let app = NSApplication.shared
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()