import CoreGraphics
import Foundation

// Moves the mouse to (dx, dy) in POINTS from the top-left of the PromptFlow (dev)
// window — a hover, no click. Use it to reveal hover-only UI (the trailing +/zoom/⋯
// cluster) before screenshotting or clicking. Matches windows by owner name like the
// other driving scripts (defaults to the DEV binary "promptflow-tauri"; override via
// PF_NEEDLE). See clickwin.swift for the click counterpart.
// Usage: swift hover.swift <dx> <dy>
guard CommandLine.arguments.count >= 3,
      let dx = Double(CommandLine.arguments[1]),
      let dy = Double(CommandLine.arguments[2]) else {
    FileHandle.standardError.write("usage: hover.swift <dx> <dy>\n".data(using: .utf8)!)
    exit(2)
}

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

let pt = CGPoint(x: o.x + dx, y: o.y + dy)
CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: pt, mouseButton: .left)?
    .post(tap: .cghidEventTap)
print("moved to \(pt.x),\(pt.y)")
