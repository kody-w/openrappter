import Foundation

/// `rappid:@owner/name:<64 hex>` — minted once, never re-minted.
///
/// Nothing in this app derives an identity from a trait, a media hash, a
/// weight, a display height or a molt stage. Those are all projections of an
/// organism whose RAPPID already exists.
struct RappidIdentity: Hashable, Codable, CustomStringConvertible {
    let owner: String
    let name: String
    let hex: String

    enum ParseError: LocalizedError, Equatable {
        case malformed(String)

        var errorDescription: String? {
            switch self {
            case let .malformed(value):
                return "Not a RAPPID: \(value)"
            }
        }
    }

    init(owner: String, name: String, hex: String) throws {
        let normalisedOwner = owner.hasPrefix("@") ? String(owner.dropFirst()) : owner
        guard !normalisedOwner.isEmpty, !name.isEmpty else {
            throw ParseError.malformed("\(owner)/\(name)")
        }
        guard hex.count == 64, hex.allSatisfy({ $0.isHexDigit && ($0.isNumber || $0.isLowercase) }) else {
            throw ParseError.malformed(hex)
        }
        self.owner = normalisedOwner
        self.name = name
        self.hex = hex
    }

    init(_ text: String) throws {
        guard text.hasPrefix("rappid:@") else { throw ParseError.malformed(text) }
        let body = text.dropFirst("rappid:@".count)
        let parts = body.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2 else { throw ParseError.malformed(text) }
        let ownerAndName = parts[0].split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false)
        guard ownerAndName.count == 2 else { throw ParseError.malformed(text) }
        try self.init(owner: String(ownerAndName[0]), name: String(ownerAndName[1]), hex: String(parts[1]))
    }

    var description: String { "rappid:@\(owner)/\(name):\(hex)" }

    /// A short, human-quotable prefix. Never a substitute for the full value.
    var shortHex: String { String(hex.prefix(12)) }

    // MARK: Codable

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        try self.init(container.decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(description)
    }
}
