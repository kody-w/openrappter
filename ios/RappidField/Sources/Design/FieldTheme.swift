import SwiftUI

/// The field's visual language: a dark cosmic ground, mint and violet accents,
/// and one distinct colour per starter path. All original, all drawn in code.
enum FieldTheme {
    static let mint = Color(red: 0.37, green: 0.95, blue: 0.76)
    static let violet = Color(red: 0.66, green: 0.55, blue: 1.00)
    static let ember = Color(red: 1.00, green: 0.64, blue: 0.38)
    static let ink = Color(red: 0.02, green: 0.03, blue: 0.07)
    static let dusk = Color(red: 0.07, green: 0.06, blue: 0.15)
    static let surface = Color(red: 0.09, green: 0.10, blue: 0.18)
    static let hairline = Color.white.opacity(0.09)
    static let secondaryText = Color.white.opacity(0.62)
    static let tertiaryText = Color.white.opacity(0.42)

    static var field: LinearGradient {
        LinearGradient(
            colors: [ink, dusk, Color(red: 0.10, green: 0.05, blue: 0.19)],
            startPoint: .top,
            endPoint: .bottom
        )
    }

    static func accent(_ path: StarterPath) -> Color {
        switch path {
        case .canopy: return Color(red: 0.44, green: 0.91, blue: 0.69)
        case .current: return Color(red: 0.35, green: 0.78, blue: 0.96)
        case .forge: return Color(red: 0.77, green: 0.55, blue: 1.00)
        }
    }

    static func secondaryAccent(_ path: StarterPath) -> Color {
        switch path {
        case .canopy: return Color(red: 0.72, green: 0.96, blue: 0.55)
        case .current: return Color(red: 0.55, green: 0.62, blue: 1.00)
        case .forge: return ember
        }
    }

    static func gradient(_ path: StarterPath) -> LinearGradient {
        LinearGradient(
            colors: [accent(path), secondaryAccent(path)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    static let cardCorner: CGFloat = 22
}

/// A starfield that is drawn, not shipped: positions come from a fixed seed so
/// the sky is the same every launch without any image asset.
struct FieldBackground: View {
    var path: StarterPath?

    private static let stars: [(x: Double, y: Double, radius: Double, alpha: Double)] = {
        var stream = DeterministicStream(seed: Digest.sha256Hex("rappid-field/starfield/1"))
        return (0..<110).map { _ in
            (
                x: Double(stream.nextBelow(1000)) / 1000,
                y: Double(stream.nextBelow(1000)) / 1000,
                radius: 0.4 + Double(stream.nextBelow(16)) / 10,
                alpha: 0.08 + Double(stream.nextBelow(45)) / 100
            )
        }
    }()

    var body: some View {
        ZStack {
            FieldTheme.field
            Canvas { context, size in
                for star in Self.stars {
                    let rect = CGRect(
                        x: star.x * size.width,
                        y: star.y * size.height,
                        width: star.radius * 2,
                        height: star.radius * 2
                    )
                    context.fill(Path(ellipseIn: rect), with: .color(.white.opacity(star.alpha)))
                }
            }
            .allowsHitTesting(false)
            if let path {
                RadialGradient(
                    colors: [FieldTheme.accent(path).opacity(0.22), .clear],
                    center: .init(x: 0.5, y: 0.16),
                    startRadius: 8,
                    endRadius: 420
                )
                .allowsHitTesting(false)
            }
        }
        .ignoresSafeArea()
    }
}
