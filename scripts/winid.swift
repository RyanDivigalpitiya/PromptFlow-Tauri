import CoreGraphics
import Foundation

// Prints the on-screen window number for the first normal-layer window owned by an app
// whose owner name contains the given string (default "PromptFlow"). Used by shot.sh to
// screencapture just our window. Owner name + window number are available without screen
// recording permission.
let needle = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "PromptFlow"
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
    FileHandle.standardError.write("no window list\n".data(using: .utf8)!)
    exit(1)
}
for info in list {
    guard let owner = info[kCGWindowOwnerName as String] as? String, owner.contains(needle),
          let num = info[kCGWindowNumber as String] as? Int,
          let layer = info[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
    print(num)
    exit(0)
}
exit(1)
