import CoreGraphics
import Foundation
let src = CGEventSource(stateID: .hidSystemState)
// Post key-up for both shift keys, cmd, option, control to unlatch anything stuck.
for code in [CGKeyCode(56), CGKeyCode(60), CGKeyCode(55), CGKeyCode(54), CGKeyCode(58), CGKeyCode(61), CGKeyCode(59), CGKeyCode(62)] {
    let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)
    up?.flags = []
    up?.post(tap: .cghidEventTap)
    usleep(20_000)
}
print("cleared")
