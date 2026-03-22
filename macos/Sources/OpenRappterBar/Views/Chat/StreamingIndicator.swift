import SwiftUI

// MARK: - Streaming Indicator

public struct StreamingIndicator: View {
    let text: String

    public init(text: String) {
        self.text = text
    }

    public var body: some View {
        HStack(alignment: .top, spacing: 6) {
            // Animated dino avatar
            Text("🦖")
                .font(.system(size: 14))
                .frame(width: 24, height: 24)
                .background(Color.green.opacity(0.15))
                .clipShape(Circle())

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    TypingDots()
                    Text("thinking...")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if !text.isEmpty {
                    Text(text)
                        .font(.callout)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Color.primary.opacity(0.06))
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                }
            }

            Spacer(minLength: 40)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 3)
    }
}

// MARK: - Typing Dots Animation

struct TypingDots: View {
    @State private var dot1 = false
    @State private var dot2 = false
    @State private var dot3 = false

    var body: some View {
        HStack(spacing: 3) {
            Circle()
                .fill(Color.green.opacity(dot1 ? 0.8 : 0.3))
                .frame(width: 5, height: 5)
            Circle()
                .fill(Color.green.opacity(dot2 ? 0.8 : 0.3))
                .frame(width: 5, height: 5)
            Circle()
                .fill(Color.green.opacity(dot3 ? 0.8 : 0.3))
                .frame(width: 5, height: 5)
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 0.5).repeatForever(autoreverses: true)) {
                dot1 = true
            }
            withAnimation(.easeInOut(duration: 0.5).repeatForever(autoreverses: true).delay(0.15)) {
                dot2 = true
            }
            withAnimation(.easeInOut(duration: 0.5).repeatForever(autoreverses: true).delay(0.3)) {
                dot3 = true
            }
        }
    }
}
