import SwiftUI

// MARK: - Menu Sessions Section

public struct MenuSessionsSection: View {
    let sessions: [Session]
    let currentSessionKey: String?
    let onSelect: (Session) -> Void
    let onDelete: (Session) -> Void
    let onNew: () -> Void

    public init(
        sessions: [Session],
        currentSessionKey: String?,
        onSelect: @escaping (Session) -> Void,
        onDelete: @escaping (Session) -> Void,
        onNew: @escaping () -> Void
    ) {
        self.sessions = sessions
        self.currentSessionKey = currentSessionKey
        self.onSelect = onSelect
        self.onDelete = onDelete
        self.onNew = onNew
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("Sessions")
                    .font(.caption)
                    .fontWeight(.semibold)
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    onNew()
                } label: {
                    Image(systemName: "plus.circle")
                        .font(.caption)
                }
                .buttonStyle(.borderless)
            }
            .padding(.horizontal, 12)
            .padding(.top, 4)

            if sessions.isEmpty {
                Text("No sessions")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 4)
            } else {
                ForEach(sessions.prefix(5)) { session in
                    SessionRow(
                        session: session,
                        isActive: session.sessionKey == currentSessionKey,
                        onSelect: { onSelect(session) },
                        onDelete: { onDelete(session) }
                    )
                }

                if sessions.count > 5 {
                    Text("\(sessions.count - 5) more...")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, 12)
                }
            }
        }
    }
}

// MARK: - Session Row

struct SessionRow: View {
    let session: Session
    let isActive: Bool
    let onSelect: () -> Void
    let onDelete: () -> Void

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 6) {
                Circle()
                    .fill(isActive ? Color.green : Color.clear)
                    .frame(width: 6, height: 6)

                VStack(alignment: .leading, spacing: 1) {
                    Text(session.displayTitle)
                        .font(.caption)
                        .lineLimit(1)
                    Text("\(session.messageCount) messages")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }

                Spacer()

                Button(action: onDelete) {
                    Image(systemName: "xmark.circle")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.borderless)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 3)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(isActive ? Color.accentColor.opacity(0.08) : Color.clear)
    }
}
