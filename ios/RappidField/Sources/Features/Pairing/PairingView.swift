import SwiftUI
import CoreImage.CIFilterBuiltins

struct PairingView: View {
    @Environment(AppModel.self) private var model
    @Environment(FieldNavigator.self) private var navigator

    @State private var nonce = UUID().uuidString
    @State private var working = false

    private var problem: String? { navigator.pairingProblem }

    private var offer: PairingOffer {
        PairingOffer(deviceName: model.deviceName, deviceInstallID: model.deviceInstallID, nonce: nonce)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                FieldBackground(path: model.chosenPath)
                ScrollView {
                    VStack(spacing: 16) {
                        statusCard
                        authorityCard
                        if !model.pairing.isPaired {
                            manualCard
                            offerCard
                            syntheticCard
                        }
                        protocolCard
                    }
                    .padding(.horizontal, 18)
                    .padding(.bottom, 24)
                }
            }
            .navigationTitle("Host")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.hidden, for: .navigationBar)
        }
    }

    private var statusCard: some View {
        FieldCard(accent: model.pairing.isPaired ? FieldTheme.mint : FieldTheme.violet) {
            VStack(alignment: .leading, spacing: 11) {
                switch model.pairing {
                case .unpaired:
                    SectionHeader(title: "No host paired", subtitle: "Everything you see is a deterministic local sample.")
                case .synthetic:
                    SectionHeader(title: "Synthetic paired mode", subtitle: "A rehearsal of the paired experience. Growth appends stay refused.")
                case let .paired(credential):
                    SectionHeader(title: "Paired", subtitle: credential.hostURL.absoluteString)
                    StatLine(label: "Credential", value: credential.credentialID)
                    StatLine(label: "Scopes", value: credential.scopes.joined(separator: ", "), note: credential.isScopedToHabitatMethodsOnly ? "Habitat methods only." : "Wider than this app asked for.")
                    StatLine(label: "Host fingerprint", value: credential.hostFingerprint)
                    if let expiry = credential.expiresAt {
                        StatLine(label: "Expires", value: expiry.formatted(date: .abbreviated, time: .shortened))
                    }
                    StatLine(label: "Token", value: "held in Keychain", note: "Never shown, never logged, never copied out of this device.")
                }

                if let notice = model.pairingNotice {
                    Text(notice)
                        .font(.system(size: 12, design: .rounded))
                        .foregroundStyle(FieldTheme.mint)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if model.pairing.isPaired {
                    Button("Remove this device's credential") {
                        Task { await model.unpair() }
                    }
                    .buttonStyle(QuietButtonStyle(tint: FieldTheme.ember))
                }
            }
        }
    }

    private var authorityCard: some View {
        FieldCard(accent: FieldTheme.mint) {
            VStack(alignment: .leading, spacing: 9) {
                SectionHeader(title: "Where the keys live")
                Text(AuthPolicy.explanation)
                    .font(.system(size: 13, design: .rounded))
                    .foregroundStyle(FieldTheme.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
                StatLine(label: "OAuth tokens on this device", value: AuthPolicy.oauthTokensOnDevice ? "yes" : "never")
                StatLine(label: "Device credential", value: "scoped, revocable")
            }
        }
    }

    private var manualCard: some View {
        @Bindable var navigator = navigator
        return FieldCard(accent: FieldTheme.accent(model.chosenPath ?? .current)) {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader(
                    title: "Enter the link your host shows",
                    subtitle: "Your host displays a RAPPID link code. Type the address and the code, or paste the whole link."
                )

                labelledField(title: "Host address", text: $navigator.pairingHostText, prompt: "http://localhost:8787")
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                labelledField(title: "One-time code", text: $navigator.pairingCodeText, prompt: "ABCD-EFGH-JKMN")
                    .textInputAutocapitalization(.characters)

                Button(working ? "Pairing…" : "Pair with this host") {
                    Task { await pair(fromFields: true) }
                }
                .buttonStyle(PrimaryButtonStyle(tint: FieldTheme.accent(model.chosenPath ?? .current)))
                .disabled(working)

                Divider().overlay(FieldTheme.hairline)

                labelledField(title: "Or paste a full link", text: $navigator.pairingLinkText, prompt: "rappid-link://pair?host=…&code=…&fp=…")
                    .textInputAutocapitalization(.never)
                Button("Pair from link") {
                    Task { await pair(fromFields: false) }
                }
                .buttonStyle(QuietButtonStyle(tint: FieldTheme.mint))
                .disabled(working || navigator.pairingLinkText.isEmpty)

                if let problem {
                    Text(problem)
                        .font(.system(size: 12, design: .rounded))
                        .foregroundStyle(FieldTheme.ember)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityLabel("Pairing problem. \(problem)")
                }
            }
        }
    }

    private var offerCard: some View {
        FieldCard(accent: FieldTheme.violet) {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader(
                    title: "Or let your host scan this",
                    subtitle: "This code carries a device name, a random per-install value and the scopes requested. No secret is in it."
                )
                if let image = QRCode.image(from: offer.qrPayload) {
                    Image(uiImage: image)
                        .interpolation(.none)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: 190)
                        .padding(10)
                        .background(RoundedRectangle(cornerRadius: 14).fill(.white))
                        .frame(maxWidth: .infinity)
                        .accessibilityLabel("Pairing offer QR code for \(model.deviceName). It contains no credential.")
                } else {
                    Text("This device could not render a QR code.")
                        .font(.system(size: 12, design: .rounded))
                        .foregroundStyle(FieldTheme.ember)
                }
                Text(offer.qrPayload)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(FieldTheme.tertiaryText)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                Button("New nonce") { nonce = UUID().uuidString }
                    .buttonStyle(QuietButtonStyle(tint: FieldTheme.secondaryText))
            }
        }
    }

    private var syntheticCard: some View {
        FieldCard(accent: FieldTheme.ember) {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(
                    title: "No host handy?",
                    subtitle: "Synthetic paired mode walks the whole flow against local fixtures."
                )
                Button("Enter synthetic paired mode") { model.enterSyntheticPairedMode() }
                    .buttonStyle(QuietButtonStyle(tint: FieldTheme.ember))
                Text("It stays honest: fixtures remain labelled, and rappid.grow keeps refusing.")
                    .font(.system(size: 12, design: .rounded))
                    .foregroundStyle(FieldTheme.tertiaryText)
            }
        }
    }

    private var protocolCard: some View {
        FieldCard(accent: FieldTheme.hairline) {
            VStack(alignment: .leading, spacing: 9) {
                SectionHeader(title: "What this device would send", subtitle: "The one-time code never goes on the wire; a domain-separated proof does.")
                ForEach(GatewayMethod.allCases, id: \.rawValue) { method in
                    StatLine(label: "Method", value: method.rawValue)
                }
                StatLine(label: "Transport", value: "URLSession WebSocket / HTTPS")
                StatLine(label: "Credential carried as", value: "Authorization header")
                StatLine(label: "Proof domain", value: PairingProof.domain)
            }
        }
    }

    private func labelledField(title: String, text: Binding<String>, prompt: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(.system(size: 12, weight: .semibold, design: .rounded))
                .foregroundStyle(FieldTheme.secondaryText)
            TextField(prompt, text: text)
                .textFieldStyle(.plain)
                .font(.system(size: 14, design: .monospaced))
                .foregroundStyle(.white)
                .autocorrectionDisabled()
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 12).fill(.white.opacity(0.06)))
                .accessibilityLabel(title)
        }
    }

    private func pair(fromFields: Bool) async {
        working = true
        defer { working = false }
        model.clearPairingNotice()
        do {
            let link: RappidLink
            if fromFields {
                link = try navigator.composedLink()
            } else {
                link = try RappidLink(parsing: navigator.pairingLinkText)
            }
            navigator.pairingProblem = nil
            await model.pairSynthetically(with: link)
        } catch {
            navigator.pairingProblem = error.localizedDescription
        }
    }
}

enum QRCode {
    /// Rendered on device with CoreImage. No network, no third-party service.
    static func image(from payload: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(payload.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 8, y: 8))
        let context = CIContext()
        guard let cgImage = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cgImage)
    }
}
