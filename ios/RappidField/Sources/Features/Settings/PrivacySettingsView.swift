import SwiftUI

struct PrivacySettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(FieldHaptics.self) private var haptics

    var body: some View {
        NavigationStack {
            ZStack {
                FieldBackground(path: model.chosenPath)
                ScrollView {
                    VStack(spacing: 16) {
                        locationCard
                        discoveryCard
                        deviceCard
                        storedCard
                        leavesCard
                    }
                    .padding(.horizontal, 18)
                    .padding(.bottom, 24)
                }
            }
            .navigationTitle("Privacy")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.hidden, for: .navigationBar)
        }
    }

    private var locationCard: some View {
        FieldCard(accent: FieldTheme.mint) {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: "Location", subtitle: "This app has never asked you for it and cannot.")
                Text(LocationPolicy.plainStatement)
                    .font(.system(size: 13, design: .rounded))
                    .foregroundStyle(FieldTheme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
                StatLine(label: "Uses CoreLocation", value: LocationPolicy.usesCoreLocation ? "yes" : "no")
                StatLine(label: "Requests permission", value: LocationPolicy.requestsLocationPermission ? "yes" : "no", note: "There is no location usage string in this app's Info.plist, so iOS could not show a prompt even if code asked.")
                StatLine(label: "Precise location", value: LocationPolicy.requestsPreciseLocation ? "yes" : "never")
                StatLine(label: "Background location", value: LocationPolicy.requestsBackgroundLocation ? "yes" : "never")
            }
        }
    }

    private var discoveryCard: some View {
        FieldCard(accent: FieldTheme.violet) {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader(
                    title: "Discovery mode",
                    subtitle: "Not built. This switch records an opinion and changes nothing about what the app collects."
                )
                Toggle(isOn: Binding(
                    get: { model.privacy.discoveryModeRequested },
                    set: { newValue in
                        var settings = model.privacy
                        settings.discoveryModeRequested = newValue
                        model.updatePrivacy(settings)
                    }
                )) {
                    Text("I would want a discovery mode")
                        .font(.system(size: 14, weight: .medium, design: .rounded))
                        .foregroundStyle(.white)
                }
                .tint(FieldTheme.violet)
                .accessibilityHint("Records a preference only. No location is collected in this build.")

                Text(LocationPolicy.futureIntent)
                    .font(.system(size: 12, design: .rounded))
                    .foregroundStyle(FieldTheme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var deviceCard: some View {
        FieldCard(accent: FieldTheme.accent(model.chosenPath ?? .current)) {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader(title: "This device")
                Toggle(isOn: Binding(
                    get: { model.privacy.hapticsEnabled },
                    set: { newValue in
                        var settings = model.privacy
                        settings.hapticsEnabled = newValue
                        model.updatePrivacy(settings)
                    }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Haptics with the wake call")
                            .font(.system(size: 14, weight: .medium, design: .rounded))
                            .foregroundStyle(.white)
                        Text(haptics.availabilityNote)
                            .font(.system(size: 11, design: .rounded))
                            .foregroundStyle(FieldTheme.tertiaryText)
                    }
                }
                .tint(FieldTheme.mint)

                Toggle(isOn: Binding(
                    get: { model.privacy.motifMotionEnabled },
                    set: { newValue in
                        var settings = model.privacy
                        settings.motifMotionEnabled = newValue
                        model.updatePrivacy(settings)
                    }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Animate the motif while it plays")
                            .font(.system(size: 14, weight: .medium, design: .rounded))
                            .foregroundStyle(.white)
                        Text("Your system Reduce Motion setting is honoured regardless of this switch.")
                            .font(.system(size: 11, design: .rounded))
                            .foregroundStyle(FieldTheme.tertiaryText)
                    }
                }
                .tint(FieldTheme.mint)
            }
        }
    }

    private var storedCard: some View {
        FieldCard(accent: FieldTheme.hairline) {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: "What is stored on this device", subtitle: "The whole list. Nothing else is written anywhere.")
                ForEach(PersistedState.allCases, id: \.rawValue) { item in
                    StatLine(label: item.rawValue, value: "local", note: item.explanation)
                }
                StatLine(label: "Device credential", value: "Keychain", note: "Only after you pair. Removing it here does not revoke it on your host; do that there too.")
            }
        }
    }

    private var leavesCard: some View {
        FieldCard(accent: FieldTheme.mint) {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: "What leaves this device")
                Text("Nothing, until you pair with a host you control. After pairing, this app speaks four methods to that host and nothing else.")
                    .font(.system(size: 13, design: .rounded))
                    .foregroundStyle(FieldTheme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(AuthPolicy.requestedScopes, id: \.self) { scope in
                    StatLine(label: scope, value: "scoped")
                }
                StatLine(label: "Analytics", value: "none")
                StatLine(label: "Third-party SDKs", value: "none")
                StatLine(label: "Age or identity checks", value: "none", note: "No path is gated, and your age is never asked for or inferred.")
            }
        }
    }
}
