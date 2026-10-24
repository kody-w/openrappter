import Carbon
import Foundation

/// Global hold-to-talk keys. Carbon hot keys need no Accessibility permission and report press and release.
@MainActor
public final class HotKeys {
    public static let shared = HotKeys()
    public static let space: UInt32 = 49
    public static let option = UInt32(optionKey), control = UInt32(controlKey), shift = UInt32(shiftKey), command = UInt32(cmdKey)

    private var handlers: [UInt32: (Bool) -> Void] = [:]
    private var refs: [EventHotKeyRef?] = []
    private var handler: EventHandlerRef?

    /// `onChange(true)` on press, `onChange(false)` on release.
    public func register(id: UInt32, keyCode: UInt32, modifiers: UInt32, _ onChange: @escaping (Bool) -> Void) {
        if handler == nil { install() }
        handlers[id] = onChange
        var ref: EventHotKeyRef?
        let hk = EventHotKeyID(signature: OSType(0x5250_5054), id: id)   // "RPPT"
        RegisterEventHotKey(keyCode, modifiers, hk, GetApplicationEventTarget(), 0, &ref)
        refs.append(ref)
    }

    private func install() {
        var specs = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
        ]
        InstallEventHandler(GetApplicationEventTarget(), { _, event, userData -> OSStatus in
            var hk = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                              nil, MemoryLayout<EventHotKeyID>.size, nil, &hk)
            let pressed = GetEventKind(event) == UInt32(kEventHotKeyPressed)
            let me = Unmanaged<HotKeys>.fromOpaque(userData!).takeUnretainedValue()
            MainActor.assumeIsolated { me.handlers[hk.id]?(pressed) }
            return noErr
        }, specs.count, &specs, Unmanaged.passUnretained(self).toOpaque(), &handler)
    }
}
