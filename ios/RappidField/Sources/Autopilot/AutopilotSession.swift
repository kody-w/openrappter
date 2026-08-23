import SwiftUI
import Observation

/// Owns the autopilot driver's lifetime, and is the only thing the app wires up.
///
/// In a Release build `AutopilotGate.isCompiledIn` is false, `start` returns
/// before constructing anything, and every carrier is a no-op — the app runs
/// exactly as if this file were not here.
@MainActor
@Observable
final class AutopilotSession {
    private(set) var isEnabled = false
    /// True when the pasteboard is also being read for commands, which the
    /// operator needs to know: the device will ask them to allow each paste.
    private(set) var readsClipboardCommands = false

    #if !DEBUG
    /// Release: there is nothing to start. The driver, the mailboxes and the
    /// command protocol are not in the binary at all.
    func start(model: AppModel, navigator: FieldNavigator, player: WakeCallPlayer, engine: GameEngine) {}
    func resume() {}
    func suspend() {}
    #else
    private(set) var driver: AutopilotDriver?

    func start(
        model: AppModel,
        navigator: FieldNavigator,
        player: WakeCallPlayer,
        engine: GameEngine,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        arguments: [String] = ProcessInfo.processInfo.arguments,
        mailbox: AutopilotMailbox? = nil
    ) {
        guard driver == nil else { return }
        guard AutopilotGate.isEnabled(environment: environment, arguments: arguments) else { return }
        // The pasteboard is the specified mailbox and is always the receipt
        // channel — publishing is never prompted. Reading commands from it is
        // opt-in, because that read raises the system paste confirmation and
        // would stall an unattended run behind a modal alert. The container
        // mailbox is the unattended way in.
        let pasteboard: AutopilotMailbox = mailbox ?? PasteboardMailbox()
        var inboxes: [AutopilotMailbox] = []
        var publishers: [AutopilotMailbox] = [pasteboard]
        // The container mailbox is polled first so a pasteboard read waiting
        // behind a system confirmation can never starve it.
        if mailbox == nil, let container = ContainerFileMailbox() {
            inboxes.append(container)
            publishers.append(container)
        }
        if mailbox != nil || AutopilotGate.isClipboardInboxEnabled(environment: environment, arguments: arguments) {
            inboxes.append(pasteboard)
        }
        let created = AutopilotDriver(
            model: model,
            navigator: navigator,
            player: player,
            engine: engine,
            inboxes: inboxes,
            publishers: publishers,
            isEnabled: true
        )
        driver = created
        isEnabled = true
        readsClipboardCommands = inboxes.contains { $0 === pasteboard }
        created.resume()
    }

    func resume() { driver?.resume() }
    func suspend() { driver?.suspend() }
    #endif
}

#if DEBUG
/// A small, unobtrusive marker so a build that can be driven never looks like
/// a build that cannot.
struct AutopilotBadge: View {
    var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(FieldTheme.ember)
                .frame(width: 5, height: 5)
            Text("AUTOPILOT")
                .font(.system(size: 9, weight: .heavy, design: .monospaced))
                .tracking(0.8)
                .foregroundStyle(FieldTheme.ember)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(Capsule().fill(FieldTheme.ink.opacity(0.72)))
        .overlay(Capsule().strokeBorder(FieldTheme.ember.opacity(0.45), lineWidth: 0.5))
        .padding(.trailing, 12)
        .allowsHitTesting(false)
        .accessibilityLabel("Debug autopilot is enabled on this build.")
    }
}
#endif
