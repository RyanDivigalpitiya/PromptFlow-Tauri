import CoreGraphics
import Foundation

// Scrolls over a point (dx,dy) in POINTS from the PromptFlow window top-left.
// Usage: swift scroll.swift <dx> <dy> <wheelDelta(neg=down)> <repeat>
guard CommandLine.arguments.count >= 5,
      let dx = Double(CommandLine.arguments[1]),
      let dy = Double(CommandLine.arguments[2]),
      let delta = Int32(CommandLine.arguments[3]),
      let reps = Int(CommandLine.arguments[4]) else { exit(2) }

let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { exit(1) }
var origin: CGPoint?
for info in list {
    guard let owner = info[kCGWindowOwnerName as String] as? String, owner.localizedCaseInsensitiveContains(ProcessInfo.processInfo.environment["PF_NEEDLE"] ?? "promptflow-tauri"),
          let layer = info[kCGWindowLayer as String] as? Int, layer == 0,
          let b = info[kCGWindowBounds as String] as? [String: Any],
          let x = b["X"] as? Double, let y = b["Y"] as? Double else { continue }
    origin = CGPoint(x: x, y: y); break
}
guard let o = origin else { exit(1) }
let pt = CGPoint(x: o.x + dx, y: o.y + dy)
let src = CGEventSource(stateID: .hidSystemState)
CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
for _ in 0..<reps {
    let e = CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 1, wheel1: delta, wheel2: 0, wheel3: 0)
    e?.location = pt
    e?.post(tap: .cghidEventTap)
    usleep(25_000)
}
print("scrolled")
