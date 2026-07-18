import CoreGraphics
import Foundation

// Drags from (x1,y1) to (x2,y2) in window-relative POINTS of the first matching window.
// Usage: swift dragwin.swift <x1> <y1> <x2> <y2> [steps]
guard CommandLine.arguments.count >= 5,
      let x1 = Double(CommandLine.arguments[1]), let y1 = Double(CommandLine.arguments[2]),
      let x2 = Double(CommandLine.arguments[3]), let y2 = Double(CommandLine.arguments[4]) else {
    FileHandle.standardError.write("usage: dragwin.swift x1 y1 x2 y2 [steps]\n".data(using: .utf8)!)
    exit(2)
}
let steps = CommandLine.arguments.count > 5 ? Int(CommandLine.arguments[5]) ?? 12 : 12
let needle = ProcessInfo.processInfo.environment["PF_NEEDLE"] ?? "promptflow-tauri"

let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { exit(1) }
var origin: CGPoint?
for info in list {
    guard let owner = info[kCGWindowOwnerName as String] as? String,
          owner.localizedCaseInsensitiveContains(needle),
          let layer = info[kCGWindowLayer as String] as? Int, layer == 0,
          let b = info[kCGWindowBounds as String] as? [String: Any],
          let x = b["X"] as? Double, let y = b["Y"] as? Double else { continue }
    origin = CGPoint(x: x, y: y)
    break
}
guard let o = origin else { FileHandle.standardError.write("window not found\n".data(using: .utf8)!); exit(1) }

let src = CGEventSource(stateID: .hidSystemState)
func post(_ type: CGEventType, _ p: CGPoint) {
    CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
}
let start = CGPoint(x: o.x + x1, y: o.y + y1)
let end = CGPoint(x: o.x + x2, y: o.y + y2)
post(.leftMouseDown, start)
usleep(80_000)
for i in 1...steps {
    let t = Double(i) / Double(steps)
    let p = CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
    post(.leftMouseDragged, p)
    usleep(28_000)
}
usleep(120_000)
post(.leftMouseUp, end)
print("dragged \(start) -> \(end)")
