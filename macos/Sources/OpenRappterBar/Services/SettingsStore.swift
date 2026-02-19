import Foundation
import AppKit

// MARK: - Settings Store

/// UserDefaults-backed settings persistence.
@Observable
@MainActor
public final class SettingsStore {
    private let defaults: UserDefaults
    private static let settingsKey = "com.openrappter.bar.settings"

    public var settings: AppSettings {
        didSet { save() }
    }

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.settingsKey),
           let decoded = try? JSONDecoder().decode(AppSettings.self, from: data) {
            self.settings = decoded
        } else {
            self.settings = AppSettings()
        }
    }

    // MARK: - Persistence

    private func save() {
        if let data = try? JSONEncoder().encode(settings) {
            defaults.set(data, forKey: Self.settingsKey)
        }
    }

    public func reset() {
        settings = AppSettings()
    }

    // MARK: - Convenience Accessors

    public var host: String {
        get { settings.connection.host }
        set { settings.connection.host = newValue }
    }

    public var port: Int {
        get { settings.connection.port }
        set { settings.connection.port = newValue }
    }

    public var autoConnect: Bool {
        get { settings.connection.autoConnect }
        set { settings.connection.autoConnect = newValue }
    }

    public var autoStartGateway: Bool {
        get { settings.connection.autoStartGateway }
        set { settings.connection.autoStartGateway = newValue }
    }

    public var showInDock: Bool {
        get { settings.ui.showInDock }
        set {
            settings.ui.showInDock = newValue
            updateDockVisibility(newValue)
        }
    }

    public var compactMode: Bool {
        get { settings.ui.compactMode }
        set { settings.ui.compactMode = newValue }
    }

    // MARK: - Dock Visibility

    private func updateDockVisibility(_ show: Bool) {
        if show {
            NSApp.setActivationPolicy(.regular)
        } else {
            NSApp.setActivationPolicy(.accessory)
        }
    }
}
