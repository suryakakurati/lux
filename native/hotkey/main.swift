// Lux hotkey listener.
//
// Modifier keys never produce keyDown/keyUp, so a listen-only event tap on
// kCGEventFlagsChanged is the only reliable way to see a *hold* on right Option.
// Right Option is keycode 61; its side-specific flag is NX_DEVICERALTKEYMASK
// (0x40), which is distinct from the generic Option mask.
//
// This tap is listen-only, so macOS asks for Input Monitoring rather than
// Accessibility. Output is one JSON object per line on stdout.

import Cocoa
import CoreGraphics

let rightOptionKeyCode: Int64 = 61
let deviceRightOptionMask: UInt64 = 0x40
let deviceLeftShiftMask: UInt64 = 0x02
let shiftMask: UInt64 = 0x20000

var tap: CFMachPort?
var rightOptionDown = false

func emit(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          var line = String(data: data, encoding: .utf8) else { return }
    line += "\n"
    fflush(stdout)
    FileHandle.standardOutput.write(line.data(using: .utf8)!)
}

func makeTap() -> CFMachPort? {
    let mask = CGEventMask(1 << CGEventType.flagsChanged.rawValue)
    guard let created = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .headInsertEventTap,
        options: .listenOnly,
        eventsOfInterest: mask,
        callback: { _, type, event, _ in
            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
                return Unmanaged.passUnretained(event)
            }
            guard type == .flagsChanged else { return Unmanaged.passUnretained(event) }

            let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
            guard keyCode == rightOptionKeyCode else { return Unmanaged.passUnretained(event) }

            let rawFlags = event.flags.rawValue
            let down = (rawFlags & deviceRightOptionMask) != 0

            if down != rightOptionDown {
                rightOptionDown = down
                if down {
                    let shift = (rawFlags & deviceLeftShiftMask) != 0 || (rawFlags & shiftMask) != 0
                    emit(["event": shift ? "chat" : "down"])
                } else {
                    emit(["event": "up"])
                }
            }
            return Unmanaged.passUnretained(event)
        },
        userInfo: nil
    ) else { return nil }
    return created
}

func installTap() {
    guard let created = makeTap() else {
        emit(["event": "denied"])
        return
    }
    tap = created
    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, created, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: created, enable: true)
    emit(["event": "ready", "tapEnabled": CGEvent.tapIsEnabled(tap: created)])
}

func waitForPermission() {
    if CGPreflightListenEventAccess() {
        installTap()
    } else {
        emit(["event": "permission", "granted": false])
        _ = CGRequestListenEventAccess()
        // Poll so granting the permission in System Settings takes effect
        // without restarting the app.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            waitForPermission()
        }
    }
}

signal(SIGTERM) { _ in exit(0) }
signal(SIGINT) { _ in exit(0) }

let heartbeat = DispatchSource.makeTimerSource(queue: DispatchQueue.main)
heartbeat.schedule(deadline: .now() + 15, repeating: 15)
heartbeat.setEventHandler { emit(["event": "alive"]) }
heartbeat.resume()

emit(["event": "booting", "version": "1.0"])
waitForPermission()
CFRunLoopRun()
