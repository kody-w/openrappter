import SwiftUI
import OpenRappterBarLib

@main
struct OpenRappterBarApp: App {
    @State private var viewModel = AppViewModel()

    var body: some Scene {
        MenuBarExtra {
            StatusMenuView(viewModel: viewModel)
        } label: {
            Image(systemName: viewModel.statusIcon)
        }
        .menuBarExtraStyle(.window)
    }
}
