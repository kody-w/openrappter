import Foundation
import Observation

enum FieldTab: String, Hashable, CaseIterable {
    case fieldGuide
    case growth
    case companion
    case host
    case privacy

    /// The vocabulary the operator and the autopilot CLI use, mapped onto the
    /// tabs. Anything not named here is refused rather than guessed at.
    static func named(_ raw: String) -> FieldTab? {
        switch raw {
        case "fieldGuide", "field-guide", "guide", "card": return .fieldGuide
        case "growth": return .growth
        case "companion", "chat": return .companion
        case "host", "pairing": return .host
        case "privacy", "settings": return .privacy
        default: return nil
        }
    }
}

enum OnboardingStage: String, Hashable {
    case welcome
    case paths
    case confirm
    case complete
}

/// The screen state the operator moves through, held in one observable place.
///
/// It lives here rather than in `@State` inside each view for one reason: the
/// autopilot has to drive exactly the state a finger drives, so there is a
/// single path to every outcome and no hidden back door that only automation
/// can reach.
@MainActor
@Observable
final class FieldNavigator {
    var selectedTab: FieldTab = .fieldGuide
    var onboardingStage: OnboardingStage = .welcome
    var onboardingSelection: StarterPath?

    var pairingHostText = "http://localhost:8787"
    var pairingCodeText = ""
    var pairingFingerprintText = ""
    var pairingLinkText = ""
    var pairingProblem: String?

    var proposal: GrowthProposal?
    var confirmationVisible = false
    private(set) var acknowledgedProposalID: String?
    var confirmationAcknowledged: Bool {
        guard let proposal else { return false }
        return acknowledgedProposalID == proposal.id
    }
    var appendRefusal: String?
    var appendReceipt: AppendReceipt?

    let chat: ChatViewModel

    init(chat: ChatViewModel? = nil) {
        self.chat = chat ?? ChatViewModel()
    }

    // MARK: Growth

    func refreshProposal(model: AppModel, progress: GameProgress = .initial) {
        let priorProposalID = proposal?.id
        guard let companion = model.selectedCompanion else {
            proposal = nil
            acknowledgedProposalID = nil
            return
        }
        proposal = model.proposal(for: companion, progress: progress)
        if proposal?.id != priorProposalID {
            acknowledgedProposalID = nil
        }
    }

    func openConfirmation() {
        acknowledgedProposalID = nil
        appendRefusal = nil
        confirmationVisible = true
    }

    func acknowledgeProposal(id: String) throws {
        guard confirmationVisible else { throw GameRefusal.confirmationNotOpen }
        guard proposal?.id == id else { throw GameRefusal.proposalChanged }
        acknowledgedProposalID = id
    }

    func dismissConfirmation() {
        confirmationVisible = false
        acknowledgedProposalID = nil
    }

    /// The one append path. The acknowledgement is checked here, and the leash,
    /// pairing and origin are checked again inside `AppModel.append`, so no
    /// caller — finger or autopilot — can skip a gate by calling differently.
    @discardableResult
    func confirmAppend(model: AppModel) async throws -> AppendReceipt {
        guard let proposal else {
            throw AppendRefusal.approvalMissing
        }
        guard acknowledgedProposalID == proposal.id else {
            throw AppendRefusal.approvalMissing
        }
        do {
            let receipt = try await model.append(
                proposal: proposal,
                approval: GrowthApproval(
                    proposal: proposal,
                    confirmationText: "Operator confirmed appending \(proposal.dimension) to \(proposal.rappid.shortHex)…"
                )
            )
            appendReceipt = receipt
            appendRefusal = nil
            dismissConfirmation()
            refreshProposal(model: model)
            return receipt
        } catch {
            appendRefusal = error.localizedDescription
            dismissConfirmation()
            throw error
        }
    }

    // MARK: Pairing

    /// Shared by the pairing screen and by autopilot, so both validate the same
    /// way. Nothing here accepts a token: a link is an address plus a one-time
    /// code, and the code never leaves the device.
    func composedLink() throws -> RappidLink {
        guard let host = URL(string: pairingHostText.trimmingCharacters(in: .whitespaces)) else {
            throw RappidLink.LinkError.badHost(pairingHostText)
        }
        return try RappidLink(
            host: host,
            code: try OneTimeCode(pairingCodeText),
            hostFingerprint: pairingFingerprintText
        )
    }

    // MARK: Reset

    func reset() {
        selectedTab = .fieldGuide
        pairingHostText = "http://localhost:8787"
        pairingCodeText = ""
        pairingFingerprintText = ""
        pairingLinkText = ""
        pairingProblem = nil
        proposal = nil
        confirmationVisible = false
        acknowledgedProposalID = nil
        appendRefusal = nil
        appendReceipt = nil
        chat.reset()
    }
}
