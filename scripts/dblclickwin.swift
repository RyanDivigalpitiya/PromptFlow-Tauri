// Double-click at window-relative logical point (owner needle promptflow-tauri).
import CoreGraphics
import Foundation
let args = CommandLine.arguments
let dx = Double(args[1])!, dy = Double(args[2])!
let needle = ProcessInfo.processInfo.environment["PF_NEEDLE"] ?? "promptflow-tauri"
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
guard let w = list.first(where: { ($0[kCGWindowOwnerName as String] as? String)?.lowercased().contains(needle) == true }),
      let b = w[kCGWindowBounds as String] as? [String: Double] else { print("no window"); exit(1) }
let p = CGPoint(x: b["X"]! + dx, y: b["Y"]! + dy)
let src = CGEventSource(stateID: .hidSystemState)
for count in 1...2 {
    let down = CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)!
    down.setIntegerValueField(.mouseEventClickState, value: Int64(count))
    down.post(tap: .cghidEventTap)
    let up = CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)!
    up.setIntegerValueField(.mouseEventClickState, value: Int64(count))
    up.post(tap: .cghidEventTap)
    usleep(60000)
}
print("dblclicked", p)
