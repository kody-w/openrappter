import Foundation

/// One content-addressed thing the organism carries.
///
/// A `(space, hash)` pair counts once no matter how many dimensions point at
/// it, which is why weight is accumulated through `WeightLedger` and never by
/// summing a list of assets.
struct ContentAddress: Hashable, Codable {
    let space: String
    let hash: String
}

struct CarriedAsset: Hashable, Codable, Identifiable {
    let dimension: String
    let path: String
    let address: ContentAddress
    /// `nil` means the size is unknown. It is never estimated.
    let bytes: Int?
    let mediaType: String
    let resident: Bool
    let verified: Bool

    var id: String { "\(dimension)/\(path)" }
}

/// Exact weight, or an explicit refusal to state one.
///
/// Unknown sizes make weight incomplete. Duplicate assets cannot make an
/// organism heavier. Nothing here rounds, estimates, or fills a gap.
struct WeightLedger: Equatable {
    private(set) var residentBytes = 0
    private(set) var linkedBytes = 0
    private(set) var unmeasured: [String] = []
    private var counted: Set<ContentAddress> = []

    init() {}

    init(assets: [CarriedAsset]) {
        for asset in assets { add(asset) }
    }

    mutating func add(_ asset: CarriedAsset) {
        guard !counted.contains(asset.address) else { return }
        counted.insert(asset.address)
        guard let bytes = asset.bytes else {
            if !unmeasured.contains(asset.dimension) {
                unmeasured.append(asset.dimension)
            }
            return
        }
        if asset.resident {
            residentBytes += bytes
        } else {
            linkedBytes += bytes
        }
    }

    var uniqueAddresses: Int { counted.count }
    var isComplete: Bool { unmeasured.isEmpty }

    /// Unique verified bytes across everything the organism carries, or `nil`
    /// when any carried dimension has an unknown size.
    var totalBytes: Int? {
        isComplete ? residentBytes + linkedBytes : nil
    }

    /// Verified bytes that are actually here, stated even when the total is
    /// incomplete, because this number is never in doubt.
    var verifiedResidentBytes: Int { residentBytes }
}

/// A versioned presentation curve over frame height.
///
/// It is not identity and not a physical fact. The version is displayed
/// wherever the number is, so a curve change can never be mistaken for growth.
enum DisplayHeightCurve: String, Codable, CaseIterable {
    case v1_2 = "display-height/1.2"

    var version: String { rawValue }

    /// Integer arithmetic only, so every runtime lands on the same millimetre.
    func millimetres(frameHeight: Int) -> Int {
        precondition(frameHeight >= 0, "frame height is a non-negative depth")
        switch self {
        case .v1_2:
            return 120 + idiv(frameHeight * 470, 10 + frameHeight)
        }
    }
}

struct CreatureStats: Equatable {
    /// Contiguous accepted append-only body-frame depth.
    let frameHeight: Int
    let uniqueFrames: Int
    let weight: WeightLedger
    let curve: DisplayHeightCurve

    var displayHeightMillimetres: Int { curve.millimetres(frameHeight: frameHeight) }
    var displayHeightVersion: String { curve.version }

    var weightComplete: Bool { weight.isComplete }
    var totalWeightBytes: Int? { weight.totalBytes }
    var residentWeightBytes: Int { weight.residentBytes }
    var linkedWeightBytes: Int { weight.linkedBytes }
    var unmeasuredDimensions: [String] { weight.unmeasured }
}

enum Formatting {
    /// Exact bytes, grouped. Never "1.2 MB": the byte count is the fact.
    static func exactBytes(_ bytes: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        // Pinned so a byte count reads the same everywhere it is quoted.
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.usesGroupingSeparator = true
        formatter.groupingSize = 3
        formatter.groupingSeparator = ","
        let number = formatter.string(from: NSNumber(value: bytes)) ?? String(bytes)
        return "\(number) B"
    }

    static func millimetres(_ value: Int) -> String {
        "\(value) mm"
    }
}
