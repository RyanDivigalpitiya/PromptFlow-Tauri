import CoreGraphics
import Foundation
// Prints ALL window numbers + bounds for windows whose owner contains the needle.
let needle = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "promptflow-tauri"
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { exit(1) }
for info in list {
    guard let owner = info[kCGWindowOwnerName as String] as? String, owner.localizedCaseInsensitiveContains(needle),
          let num = info[kCGWindowNumber as String] as? Int,
          let layer = info[kCGWindowLayer as String] as? Int, layer == 0,
          let b = info[kCGWindowBounds as String] as? [String: Any],
          let x = b["X"] as? Double, let y = b["Y"] as? Double else { continue }
    print("\(num) \(Int(x)) \(Int(y))")
}
