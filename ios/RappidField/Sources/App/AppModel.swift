import Foundation
import Observation
import UIKit

@MainActor
@Observable
final class AppModel {
    enum LoadState: Equatable {
        case idle
        case loading
        case loaded
        case failed(String)
    }

    private(set) var roster: [Companion] = []
    private(set) var loadState: LoadState = .idle
    private(set) var pairing: PairingStatus = .unpaired
    private(set) var pairingNotice: String?

    var chosenPath: StarterPath?
    var onboardingComplete: Bool
    var leash: SelfSteerLeash
    var privacy: PrivacySettings
    var selectedCompanionID: String?

    let deviceInstallID: String
    let credentialStore: CredentialStoring
    private let defaults: UserDefaults

    private(set) var gateway: RappidGateway = SyntheticGateway()

    init(defaults: UserDefaults = .standard, credentialStore: CredentialStoring = KeychainCredentialStore()) {
        self.defaults = defaults
        self.credentialStore = credentialStore
        self.onboardingComplete = defaults.bool(forKey: PersistedState.onboardingComplete.rawValue)
        self.chosenPath = defaults.string(forKey: PersistedState.starterPath.rawValue).flatMap(StarterPath.init(rawValue:))
        self.leash = defaults.string(forKey: PersistedState.leash.rawValue).flatMap(SelfSteerLeash.init(rawValue:)) ?? .propose
        if let data = defaults.data(forKey: PersistedState.privacy.rawValue),
           let decoded = try? JSONDecoder().decode(PrivacySettings.self, from: data) {
            self.privacy = decoded
        } else {
            self.privacy = .default
        }
        if let existing = defaults.string(forKey: PersistedState.deviceInstallID.rawValue) {
            self.deviceInstallID = existing
        } else {
            let created = UUID().uuidString
            defaults.set(created, forKey: PersistedState.deviceInstallID.rawValue)
            self.deviceInstallID = created
        }
    }

    var deviceName: String {
        UIDevice.current.name
    }

    var selectedCompanion: Companion? {
        if let selectedCompanionID, let found = roster.first(where: { $0.id == selectedCompanionID }) {
            return found
        }
        if let chosenPath, let owned = roster.first(where: { $0.path == chosenPath }) {
            return owned
        }
        return roster.first
    }

    var ownedCompanion: Companion? {
        guard let chosenPath else { return nil }
        return roster.first { $0.path == chosenPath }
    }

    // MARK: Onboarding

    func choose(path: StarterPath) {
        chosenPath = path
        leash = path.defaultLeash
        defaults.set(path.rawValue, forKey: PersistedState.starterPath.rawValue)
        defaults.set(leash.rawValue, forKey: PersistedState.leash.rawValue)
    }

    func completeOnboarding() {
        onboardingComplete = true
        defaults.set(true, forKey: PersistedState.onboardingComplete.rawValue)
    }

    func setLeash(_ value: SelfSteerLeash) {
        leash = value
        defaults.set(value.rawValue, forKey: PersistedState.leash.rawValue)
    }

    func updatePrivacy(_ settings: PrivacySettings) {
        privacy = settings
        if let data = try? JSONEncoder().encode(settings) {
            defaults.set(data, forKey: PersistedState.privacy.rawValue)
        }
    }

    // MARK: Habitat

    func bootstrap() async {
        if let credential = try? await credentialStore.load(), !credential.isExpired() {
            adopt(credential: credential)
        }
        await refresh()
    }

    func refresh() async {
        loadState = .loading
        do {
            roster = try await gateway.list()
            loadState = .loaded
        } catch {
            roster = []
            loadState = .failed(error.localizedDescription)
        }
    }

    // MARK: Pairing

    /// Builds the payload this device would hand the host. It carries a proof
    /// derived from the one-time code, never the code and never a token.
    func pairingRequest(code: OneTimeCode, nonce: String = UUID().uuidString) -> PairingRequest {
        PairingRequest(deviceName: deviceName, deviceInstallID: deviceInstallID, nonce: nonce, code: code)
    }

    /// The prototype's stand-in for the host's grant. A real host mints this;
    /// nothing here contacts GitHub, Copilot, or any account system.
    func pairSynthetically(with link: RappidLink) async {
        let credential = DeviceCredential(
            credentialID: String(Digest.sha256Hex("\(deviceInstallID):\(link.code.normalised)").prefix(16)),
            token: "synthetic-scoped-credential-\(UUID().uuidString)",
            scopes: AuthPolicy.requestedScopes,
            hostURL: link.host,
            hostFingerprint: link.hostFingerprint,
            issuedAt: Date(),
            expiresAt: Calendar.current.date(byAdding: .day, value: 7, to: Date()),
            isSyntheticGrant: true
        )
        do {
            try await credentialStore.save(credential)
            adopt(credential: credential)
            pairingNotice = "Paired with \(link.host.absoluteString). This device now holds a scoped credential your host can revoke. No host was actually contacted, so the field still shows deterministic samples."
        } catch let error as CredentialStoreError where error.isMissingEntitlement {
            pairingNotice = "This build cannot reach the Keychain here, so the credential was not stored. Pairing was not completed."
        } catch {
            pairingNotice = "Pairing failed: \(error.localizedDescription)"
        }
        await refresh()
    }

    func enterSyntheticPairedMode() {
        pairing = .synthetic
        gateway = SyntheticGateway()
        pairingNotice = "Synthetic paired mode. Every companion is a deterministic local fixture, and growth appends stay refused."
    }

    func unpair() async {
        do {
            try await credentialStore.clear()
            pairing = .unpaired
            gateway = SyntheticGateway()
            pairingNotice = "Credential removed from this device. Revoke it on your host as well if you want it gone everywhere."
        } catch {
            pairingNotice = "Could not remove the credential: \(error.localizedDescription)"
        }
        await refresh()
    }

    /// Returns a configured prototype to its unpaired synthetic field. The
    /// operator's onboarding choice and privacy preferences remain intact.
    /// Errors propagate rather than leaving a half-reset device looking clean.
    func resetToSyntheticField() async throws {
        try await credentialStore.clear()
        pairing = .unpaired
        gateway = SyntheticGateway()
        selectedCompanionID = nil
        pairingNotice = nil
        await refresh()
    }

    private func adopt(credential: DeviceCredential) {
        pairing = .paired(credential)
        guard !credential.isSyntheticGrant else {
            // A locally minted grant has no host behind it. Serving fixtures
            // keeps the habitat honest — they stay labelled synthetic, and
            // growth appends stay refused.
            gateway = SyntheticGateway()
            return
        }
        let transport = WebSocketHostTransport(
            hostURL: credential.hostURL,
            credentials: StoredCredentialProvider(store: credentialStore)
        )
        gateway = HostGateway(transport: transport, hostURL: credential.hostURL)
    }

    func clearPairingNotice() {
        pairingNotice = nil
    }

    // MARK: Growth

    func proposal(for companion: Companion, progress: GameProgress = .initial) -> GrowthProposal? {
        ProposalEngine.propose(for: companion, leash: leash, progress: progress)
    }

    /// The only path to an append. Every refusal is thrown, never swallowed.
    func append(proposal: GrowthProposal, approval: GrowthApproval?) async throws -> AppendReceipt {
        let request = try GrowthLeashPolicy.authorise(
            proposal: proposal,
            approval: approval,
            leash: leash,
            paired: pairing.isPaired
        )
        let receipt = try await gateway.grow(request)
        await refresh()
        return receipt
    }
}
