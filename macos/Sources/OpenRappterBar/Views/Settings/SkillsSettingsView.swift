import SwiftUI

// MARK: - Skills Settings View

public struct SkillsSettingsView: View {
    @Bindable var viewModel: SkillsViewModel
    @State private var searchText = ""

    public init(viewModel: SkillsViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Skills")
                    .font(.headline)
                Spacer()
                Button {
                    viewModel.loadSkills()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
            }
            .padding()

            Divider()

            if viewModel.isLoading {
                ProgressView("Loading skills...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if viewModel.skills.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "puzzlepiece.extension")
                        .font(.largeTitle)
                        .foregroundStyle(.tertiary)
                    Text("No skills installed")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    Text("Install skills from ClawHub via the gateway CLI.")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    ForEach(viewModel.skills) { skill in
                        SkillRow(skill: skill) {
                            viewModel.toggleSkill(skill)
                        }
                    }
                }
                .listStyle(.inset(alternatesRowBackgrounds: true))
            }

            if let error = viewModel.error {
                ErrorBanner(message: error) {
                    viewModel.error = nil
                }
            }
        }
        .onAppear { viewModel.loadSkills() }
    }
}

struct SkillRow: View {
    let skill: Skill
    let onToggle: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "puzzlepiece.extension.fill")
                .foregroundStyle(skill.enabled ? .blue : .gray)

            VStack(alignment: .leading, spacing: 2) {
                Text(skill.name)
                    .font(.callout)
                    .fontWeight(.medium)
                HStack(spacing: 4) {
                    if let version = skill.version {
                        Text("v\(version)")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    Text(skill.source.rawValue)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    if let author = skill.author {
                        Text("by \(author)")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }

            Spacer()

            Toggle("", isOn: .constant(skill.enabled))
                .toggleStyle(.switch)
                .controlSize(.mini)
                .onTapGesture { onToggle() }
        }
        .padding(.vertical, 4)
    }
}
