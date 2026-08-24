import SwiftUI

struct FieldCard<Content: View>: View {
    var accent: Color = FieldTheme.mint
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: FieldTheme.cardCorner, style: .continuous)
                    .fill(FieldTheme.surface.opacity(0.92))
            )
            .overlay(
                RoundedRectangle(cornerRadius: FieldTheme.cardCorner, style: .continuous)
                    .strokeBorder(
                        LinearGradient(
                            colors: [accent.opacity(0.45), Color.white.opacity(0.06)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        lineWidth: 1
                    )
            )
    }
}

struct FieldTag: View {
    let text: String
    var color: Color = FieldTheme.mint
    var filled = false

    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .semibold, design: .rounded))
            .tracking(0.6)
            .textCase(.uppercase)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(
                Capsule().fill(filled ? color.opacity(0.9) : color.opacity(0.16))
            )
            .foregroundStyle(filled ? FieldTheme.ink : color)
    }
}

/// A label/value row where the value is the fact and never gets abbreviated.
struct StatLine: View {
    let label: String
    let value: String
    var note: String?
    var valueColor: Color = .white

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline) {
                Text(label)
                    .font(.system(size: 13, weight: .medium, design: .rounded))
                    .foregroundStyle(FieldTheme.secondaryText)
                Spacer(minLength: 12)
                Text(value)
                    .font(.system(size: 14, weight: .semibold, design: .monospaced))
                    .foregroundStyle(valueColor)
                    .multilineTextAlignment(.trailing)
            }
            if let note {
                Text(note)
                    .font(.system(size: 11, design: .rounded))
                    .foregroundStyle(FieldTheme.tertiaryText)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(value)\(note.map { ". \($0)" } ?? "")")
    }
}

struct TraitBar: View {
    let label: String
    let milli: Int
    var color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(label.capitalized)
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .foregroundStyle(FieldTheme.secondaryText)
                Spacer()
                Text("\(milli)/1000")
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundStyle(FieldTheme.tertiaryText)
            }
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.08))
                    Capsule()
                        .fill(color)
                        .frame(width: geometry.size.width * CGFloat(milli) / 1000)
                }
            }
            .frame(height: 6)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label), \(milli) of 1000")
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    var tint: Color = FieldTheme.mint

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .semibold, design: .rounded))
            .foregroundStyle(FieldTheme.ink)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(tint.opacity(configuration.isPressed ? 0.75 : 1))
            )
            .scaleEffect(configuration.isPressed ? 0.985 : 1)
    }
}

struct QuietButtonStyle: ButtonStyle {
    var tint: Color = FieldTheme.mint

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 14, weight: .semibold, design: .rounded))
            .foregroundStyle(tint)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(tint.opacity(configuration.isPressed ? 0.8 : 0.4), lineWidth: 1)
            )
    }
}

struct SectionHeader: View {
    let title: String
    var subtitle: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.system(size: 19, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
            if let subtitle {
                Text(subtitle)
                    .font(.system(size: 13, design: .rounded))
                    .foregroundStyle(FieldTheme.secondaryText)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The banner that never lets a fixture pass for an organism.
struct OriginBanner: View {
    let origin: DataOrigin

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: origin.isSynthetic ? "flask" : "link")
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(origin.isSynthetic ? FieldTheme.ember : FieldTheme.mint)
            VStack(alignment: .leading, spacing: 3) {
                Text(origin.badge)
                    .font(.system(size: 11, weight: .heavy, design: .rounded))
                    .tracking(1)
                    .foregroundStyle(origin.isSynthetic ? FieldTheme.ember : FieldTheme.mint)
                Text(origin.detail)
                    .font(.system(size: 12, design: .rounded))
                    .foregroundStyle(FieldTheme.secondaryText)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill((origin.isSynthetic ? FieldTheme.ember : FieldTheme.mint).opacity(0.10))
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(origin.badge). \(origin.detail)")
    }
}
