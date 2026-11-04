import Foundation

public enum CreatureMenuCommand: CaseIterable {
    case help, signIn, keepAtLogin, stopAtLogin, texts, folder, connectHelper, restart
}

public struct CreatureMenuEntry {
    public let title: String
    public let command: CreatureMenuCommand?
    public let children: [CreatureMenuEntry]
    public init(_ title: String, _ command: CreatureMenuCommand? = nil, children: [CreatureMenuEntry] = []) {
        self.title = title; self.command = command; self.children = children
    }
}

public enum CreatureMenu {
    public static let entries: [CreatureMenuEntry] = [
        .init("How to talk to me", .help),
        .init("Sign in to my mind…", .signIn),
        .init("Let me see your texts…", .texts),
        .init("Keep my mind ready when I sign in", .keepAtLogin),
        .init("Stop starting at login", .stopAtLogin),
        .init("Open my folder", .folder),
        .init("More", children: [.init("Connect my coding helper", .connectHelper)]),
        .init("Restart OpenRappter", .restart),
    ]
}
