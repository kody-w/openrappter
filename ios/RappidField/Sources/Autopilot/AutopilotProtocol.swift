// Debug autopilot. The whole file is compiled out of Release builds;
// see AutopilotGate for the second, explicit launch-time lock.
#if DEBUG
import Foundation

/// The complete set of things autopilot is allowed to ask for.
///
/// This is an allowlist, not a dispatch table over some richer surface. There
/// is deliberately no action that evaluates code, addresses a view by selector
/// or coordinate, fetches a URL, touches the filesystem, runs a shell, injects
/// a credential, bypasses a confirmation, or deletes anything the operator
/// would miss. Adding one would mean adding a case here, in review.
enum AutopilotAction: String, Codable, CaseIterable {
    case navigate
    case selectStarter
    case confirmStarter
    case openCard
    case inspectCompanion
    case fillPairingHost
    case fillPairingCode
    case submitSyntheticPair
    case playWakeCall
    case stopWakeCall
    case beginEncounter
    case encounterMove
    case leaveEncounter
    case beginTraining
    case trainingAnswer
    case endTraining
    case setLeash
    case requestProposal
    case openConfirmation
    case acknowledgeConfirmation
    case approveAppend
    case cancelAppend
    case fillChatInput
    case sendChat
    case cancelChat
    case resetSyntheticState
    case snapshot
}

/// `{"type":"command","version":1,"id":"…","action":"…","target":"…","value":"…"}`
struct AutopilotCommand: Equatable {
    static let payloadType = "command"
    static let version = 1
    /// Nothing this app accepts needs to be large. Anything bigger is refused
    /// rather than parsed.
    static let maximumPayloadBytes = 4_096
    static let maximumValueLength = 512

    let id: String
    /// A strictly increasing cursor. It is required, because a command with no
    /// place in the order is a fire-and-forget command, and this mailbox does
    /// not accept those.
    let seq: Int
    let action: AutopilotAction
    let target: String?
    let value: String?
}

enum AutopilotStatus: String, Codable {
    case ok
    case refused
    case error
}

enum AutopilotRefusal: Error, Equatable {
    case malformedPayload(String)
    case unsupportedVersion(String)
    case unknownAction(String)
    case missingIdentifier
    case duplicateIdentifier
    case missingSequence(String)
    case staleSequence(seq: Int, cursor: Int)
    case busy(String)
    case commandTimedOut(String)
    case badTarget(String)
    case valueMissing
    case valueRejected(String)
    case notApplicable(String)
    case requiresOperatorConfirmation(String)
    case disabled

    /// A stable machine code, plus a short human tail. Bounded on purpose.
    var code: String {
        switch self {
        case let .malformedPayload(detail): return "malformed-payload: \(detail)"
        case let .unsupportedVersion(detail): return "unsupported-version: \(detail)"
        case let .unknownAction(name): return "unknown-action: \(name)"
        case .missingIdentifier: return "missing-command-id"
        case .duplicateIdentifier: return "duplicate-command-id"
        case let .missingSequence(detail): return "missing-sequence: \(detail)"
        case let .staleSequence(seq, cursor): return "stale-sequence: \(seq) is not past cursor \(cursor)"
        case let .busy(detail): return "busy: \(detail)"
        case let .commandTimedOut(detail): return "command-timeout: \(detail)"
        case let .badTarget(detail): return "bad-target: \(detail)"
        case .valueMissing: return "value-missing"
        case let .valueRejected(detail): return "value-rejected: \(detail)"
        case let .notApplicable(detail): return "not-applicable: \(detail)"
        case let .requiresOperatorConfirmation(detail): return "requires-operator-confirmation: \(detail)"
        case .disabled: return "autopilot-disabled"
        }
    }
}

/// What the mailbox found. Anything that is not one of our commands is
/// *ignored* rather than refused: the general pasteboard belongs to the
/// operator, and their shopping list is not a malformed command.
enum AutopilotIntake: Equatable {
    case ignored(String)
    case refused(id: String, refusal: AutopilotRefusal)
    case command(AutopilotCommand)
}

enum AutopilotParser {
    private static let allowedKeys: Set<String> = ["type", "version", "seq", "id", "action", "target", "value"]

    static func parse(_ payload: String) -> AutopilotIntake {
        guard payload.utf8.count <= AutopilotCommand.maximumPayloadBytes else {
            return .ignored("payload-too-large")
        }
        let trimmed = payload.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("{"), let data = trimmed.data(using: .utf8) else {
            return .ignored("not-json")
        }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return .ignored("not-a-json-object")
        }
        guard let type = object["type"] as? String else { return .ignored("no-type") }
        guard type == AutopilotCommand.payloadType else { return .ignored("not-a-command") }

        // From here the payload claims to be ours, so problems are refusals
        // with a receipt rather than silence.
        let id = (object["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !id.isEmpty, id.count <= 128 else {
            return .refused(id: "", refusal: .missingIdentifier)
        }
        let unknownKeys = Set(object.keys).subtracting(allowedKeys)
        guard unknownKeys.isEmpty else {
            return .refused(id: id, refusal: .malformedPayload("unexpected keys \(unknownKeys.sorted().joined(separator: ","))"))
        }
        guard let version = object["version"] as? Int else {
            return .refused(id: id, refusal: .unsupportedVersion("missing"))
        }
        guard version == AutopilotCommand.version else {
            return .refused(id: id, refusal: .unsupportedVersion("\(version)"))
        }
        guard let actionName = object["action"] as? String else {
            return .refused(id: id, refusal: .unknownAction("missing"))
        }
        guard let action = AutopilotAction(rawValue: actionName) else {
            return .refused(id: id, refusal: .unknownAction(String(actionName.prefix(48))))
        }
        guard let seq = object["seq"] as? Int else {
            return .refused(id: id, refusal: .missingSequence("a command needs a sequence number"))
        }
        guard seq > 0 else {
            return .refused(id: id, refusal: .missingSequence("a sequence number starts at 1"))
        }

        var target: String?
        if let raw = object["target"] {
            guard let text = raw as? String else {
                return .refused(id: id, refusal: .malformedPayload("target must be a string"))
            }
            target = text
        }
        var value: String?
        if let raw = object["value"] {
            guard let text = raw as? String else {
                return .refused(id: id, refusal: .malformedPayload("value must be a string"))
            }
            guard text.count <= AutopilotCommand.maximumValueLength else {
                return .refused(id: id, refusal: .valueRejected("value longer than \(AutopilotCommand.maximumValueLength)"))
            }
            value = text
        }

        return .command(AutopilotCommand(id: id, seq: seq, action: action, target: target, value: value))
    }
}

/// The pending reading, as a receipt states it.
struct AutopilotProposalState: Codable, Equatable {
    var id: String
    /// Always false, and stated anyway so a reader never has to assume.
    var authoritative: Bool
    var appendable: Bool
    var dimension: String
    var predictedFrameHeight: Int
}

/// An open discovery encounter, and the moves it will accept.
struct AutopilotEncounterState: Codable, Equatable {
    var id: String
    var kind: String
    var strength: Int
    var step: Int
    var stepsRemaining: Int
    var attunement: Int
    var revealedNotes: Int
    var phase: String
    var moves: [String]
}

/// A drill in progress. `intervals` is the shape of the current fragment, which
/// is what makes the drill playable from the receipt alone.
struct AutopilotTrainingState: Codable, Equatable {
    var id: String
    var round: Int
    var rounds: Int
    var correct: Int
    var phase: String
    var intervals: [Int]
    var answers: [String]
}

/// The bounded semantic snapshot a receipt carries.
///
/// Every field is a small, named fact about the game. There are no
/// coordinates, no view identifiers, no free text from the conversation, and —
/// by construction — no credential, token, one-time code, or host address.
/// `availableActions` is what makes it playable: it is computed by the game's
/// own reducer, so an agent can read the list and send one straight back.
struct AutopilotState: Codable, Equatable {
    var screen: String
    var onboarding: String
    var starter: String?
    var stage: String?
    var companion: String?
    var rappidShortHex: String?
    var frameHeight: Int?
    var weightComplete: Bool?
    var weightBytes: Int?
    var displayHeightMm: Int?
    var displayHeightVersion: String?
    var dimensions: Int?
    var traits: [String: Int]?
    var origin: String
    var pairing: String
    var pairingHostFilled: Bool
    var pairingCodeFilled: Bool
    var leash: String
    var proposal: AutopilotProposalState?
    var confirmationVisible: Bool
    var confirmationAcknowledged: Bool
    var appendRefusal: String?
    var wakeCall: String
    var chatPhase: String
    var chatMessages: Int
    var chatInputFilled: Bool
    var rosterCount: Int
    var attunement: Int
    var encountersResolved: Int
    var drillsCompleted: Int
    var encounter: AutopilotEncounterState?
    var training: AutopilotTrainingState?
    var lastOutcome: String?
    var availableActions: [String]

    /// Every key a receipt is allowed to carry. A snapshot emits a subset of
    /// these — an absent fact is omitted rather than reported as null — and
    /// tests assert the subset relation, so a future field cannot quietly
    /// widen what leaves the app.
    static let allowedKeys: Set<String> = [
        "screen", "onboarding", "starter", "stage", "companion", "rappidShortHex",
        "frameHeight", "weightComplete", "weightBytes", "displayHeightMm",
        "displayHeightVersion", "dimensions", "traits", "origin", "pairing",
        "pairingHostFilled", "pairingCodeFilled", "leash", "proposal",
        "confirmationVisible", "confirmationAcknowledged", "appendRefusal",
        "wakeCall", "chatPhase", "chatMessages", "chatInputFilled", "rosterCount",
        "attunement", "encountersResolved", "drillsCompleted", "encounter",
        "training", "lastOutcome", "availableActions",
    ]
}

struct AutopilotReceipt: Codable, Equatable {
    static let payloadType = "receipt"

    var type: String = AutopilotReceipt.payloadType
    var version: Int = AutopilotCommand.version
    var id: String
    /// Echoed from the command, so a caller can prove the answer belongs to the
    /// question it just asked.
    var seq: Int
    /// The driver's cursor after handling. It advances only for a command that
    /// was accepted for execution.
    var cursor: Int
    var status: AutopilotStatus
    var state: AutopilotState
    var error: String?

    /// Errors are truncated so a receipt stays a small, bounded artefact.
    static func truncatedError(_ text: String) -> String {
        String(text.prefix(200))
    }

    func encoded() -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(self) else {
            return "{\"type\":\"receipt\",\"version\":1,\"seq\":\(seq),\"cursor\":\(cursor),\"id\":\"\(id)\",\"status\":\"error\"}"
        }
        return String(decoding: data, as: UTF8.self)
    }
}
#endif
