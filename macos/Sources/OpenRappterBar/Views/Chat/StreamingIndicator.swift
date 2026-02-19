import SwiftUI

// MARK: - Streaming Indicator

public struct StreamingIndicator: View {
    let text: String

    public init(text: String) {
        self.text = text
    }

    public var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "cpu")
                .font(.caption)
                .foregroundStyle(.green)
                .frame(width: 16, alignment: .center)
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 4) {
                    ProgressView()
                        .controlSize(.mini)
                    Text("Assistant")
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundStyle(.green)
                }

                Text(text)
                    .font(.callout)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(.fill.tertiary)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }
}
