import CoreGraphics
import Foundation

// Clicks at a point offset (dx, dy) in POINTS from the top-left of the PromptFlow window.
// Usage: swift clickwin.swift <dx> <dy>
guard CommandLine.arguments.count >= 3,
      let dx = Double(CommandLine.arguments[1]),
      let dy = Double(CommandLine.arguments[2]) else {
    FileHandle.standardError.write("usage: clickwin.swift <dx> <dy>\n".data(using: .utf8)!)
    exit(2)
}

let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { exit(1) }

var origin: CGPoint?
for info in list {
    guard let owner = info[kCGWindowOwnerName as String] as? String, owner.localizedCaseInsensitiveContains(ProcessInfo.processInfo.environment["PF_NEEDLE"] ?? "promptflow-tauri"),
          let layer = info[kCGWindowLayer as String] as? Int, layer == 0,
          let b = info[kCGWindowBounds as String] as? [String: Any],
          let x = b["X"] as? Double, let y = b["Y"] as? Double else { continue }
    origin = CGPoint(x: x, y: y)
    break
}
guard let o = origin else { FileHandle.standardError.write("window not found\n".data(using: .utf8)!); exit(1) }

let pt = CGPoint(x: o.x + dx, y: o.y + dy)
let src = CGEventSource(stateID: .hidSystemState)
let shift = ProcessInfo.processInfo.environment["PF_SHIFT"] == "1"
let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: pt, mouseButton: .left)
let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: pt, mouseButton: .left)
if shift { down?.flags = .maskShift; up?.flags = .maskShift }
down?.post(tap: .cghidEventTap)
usleep(60_000)
up?.post(tap: .cghidEventTap)
print("clicked \(pt.x),\(pt.y)")
