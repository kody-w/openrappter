import SwiftUI

public struct ConfigEditorView: View {
    @Bindable var viewModel: SettingsViewModel

    public init(viewModel: SettingsViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Gateway Configuration")
                    .font(.headline)
                Spacer()
                Button("Reload") {
                    viewModel.loadConfig()
                }
                .controlSize(.small)
                Button("Save") {
                    viewModel.saveConfig()
                }
                .controlSize(.small)
                .buttonStyle(.borderedProminent)
            }

            if viewModel.isLoadingConfig {
                ProgressView("Loading configuration...")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                TextEditor(text: $viewModel.configYaml)
                    .font(.system(.body, design: .monospaced))
                    .scrollContentBackground(.visible)
                    .border(Color.secondary.opacity(0.3))
            }

            if let error = viewModel.configError {
                HStack(spacing: 4) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }
        }
        .padding()
        .onAppear {
            viewModel.loadConfig()
        }
    }
}
