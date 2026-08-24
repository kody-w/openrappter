import Foundation
import CryptoKit

/// Canonical bytes and the one deterministic byte stream this app shares with
/// the OpenRappter host runtimes.
///
/// Two runtimes only agree about a hash if they agree about the bytes, so the
/// canonical form is pinned here and nowhere else: keys sorted, no whitespace,
/// ASCII escaped. That is byte-identical to the host's canonical JSON, which is
/// what makes an offline iPhone able to reproduce the same 16-note identity
/// motif and the same `dna-prompt.mid` bytes the host already recorded.
enum CanonicalJSON {
    /// The exact-integer profile: the only value shapes an identity seed uses.
    indirect enum Value {
        case string(String)
        case int(Int)
        case bool(Bool)
        case null
        case array([Value])
        case object([String: Value])
    }

    /// JSON with sorted keys, no spaces and ASCII escapes.
    static func render(_ value: Value) -> String {
        switch value {
        case .null:
            return "null"
        case let .bool(flag):
            return flag ? "true" : "false"
        case let .int(number):
            return String(number)
        case let .string(text):
            return escape(text)
        case let .array(items):
            return "[" + items.map(render).joined(separator: ",") + "]"
        case let .object(fields):
            let body = fields.keys.sorted().map { key in
                "\(escape(key)):\(render(fields[key]!))"
            }
            return "{" + body.joined(separator: ",") + "}"
        }
    }

    /// `ensure_ascii`: every UTF-16 code unit outside printable ASCII becomes
    /// `\uXXXX`, matching the host's canonical writer exactly.
    private static func escape(_ text: String) -> String {
        var out = "\""
        for unit in text.utf16 {
            switch unit {
            case 0x22: out += "\\\""
            case 0x5C: out += "\\\\"
            case 0x08: out += "\\b"
            case 0x0C: out += "\\f"
            case 0x0A: out += "\\n"
            case 0x0D: out += "\\r"
            case 0x09: out += "\\t"
            case 0x20...0x7E:
                out.append(Character(UnicodeScalar(unit)!))
            default:
                out += String(format: "\\u%04x", unit)
            }
        }
        return out + "\""
    }
}

enum Digest {
    static func sha256(_ data: Data) -> Data {
        Data(CryptoKit.SHA256.hash(data: data))
    }

    static func sha256Hex(_ data: Data) -> String {
        hex(sha256(data))
    }

    static func sha256Hex(_ text: String) -> String {
        sha256Hex(Data(text.utf8))
    }

    static func hex(_ data: Data) -> String {
        data.map { String(format: "%02x", $0) }.joined()
    }
}

/// Floor division for non-negative operands, named rather than inlined because
/// every use site here must be the case where every runtime agrees.
func idiv(_ numerator: Int, _ denominator: Int) -> Int {
    precondition(denominator > 0, "idiv requires a positive denominator")
    precondition(numerator >= 0, "idiv requires a non-negative numerator")
    return numerator / denominator
}

/// Half-up rounding, spelled out: language built-ins disagree at exactly `.5`.
func roundHalfUp(_ value: Double) -> Int {
    Int((value + 0.5).rounded(.down))
}

/// A deterministic byte stream seeded by a hex digest.
///
/// `block_n = sha256("<seed>:<n>")`, consumed a byte at a time. Every runtime
/// produces the same bytes for the same seed, forever, offline.
struct DeterministicStream {
    private let seed: String
    private var counter = 0
    private var block: [UInt8] = []
    private var offset = 0

    init(seed: String) {
        precondition(!seed.isEmpty, "DeterministicStream requires a seed")
        self.seed = seed
    }

    private mutating func nextByte() -> UInt8 {
        if offset >= block.count {
            block = Array(Digest.sha256(Data("\(seed):\(counter)".utf8)))
            counter += 1
            offset = 0
        }
        let byte = block[offset]
        offset += 1
        return byte
    }

    mutating func nextUInt32() -> UInt32 {
        var value: UInt32 = 0
        for _ in 0..<4 {
            value = (value << 8) | UInt32(nextByte())
        }
        return value
    }

    /// A uniform integer in `[0, bound)`. Rejection sampled, so unbiased.
    mutating func nextBelow(_ bound: Int) -> Int {
        precondition(bound > 0, "nextBelow requires a positive integer bound")
        let limit = (0x1_0000_0000 / bound) * bound
        while true {
            let value = Int(nextUInt32())
            if value < limit { return value % bound }
        }
    }
}
