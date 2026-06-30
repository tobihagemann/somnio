import SomnioCore
import SomnioScene3D
import SomnioUI
import SwiftUI

/// Hosts `MainWindowView` plus the modal sheet stack and the chat-input focus
/// bridge. Lives in the player client because it stitches together view-model state
/// with the SomnioUI composition contract. `MainWindowView` owns the chat focus state
/// and reports changes here through the `onChatFocusChange` callback.
@MainActor public struct MainWindowContainerView: View {
    @Bindable var viewModel: ClientViewModel
    /// The concrete 3D renderer, threaded in from the app entry rather than recovered from the
    /// erased `viewModel.worldScene`, because `WorldScene3DView` needs the concrete type.
    private let renderer: WorldScene3D
    private let onCheckForUpdates: () -> Void

    public init(viewModel: ClientViewModel, renderer: WorldScene3D, onCheckForUpdates: @escaping () -> Void) {
        self._viewModel = Bindable(viewModel)
        self.renderer = renderer
        self.onCheckForUpdates = onCheckForUpdates
    }

    public var body: some View {
        MainWindowView(
            playField: WorldScene3DView(scene: renderer)
                .overlay {
                    MouseFacingTrackingView { facing in viewModel.updateMouseFacing(facing) }
                },
            energy: viewModel.energy,
            players: viewModel.players,
            items: viewModel.inventory,
            chatLines: viewModel.chatLines,
            chatInput: $viewModel.chatInput,
            onSubmitChat: { viewModel.submitChat() },
            onItemActivate: { row in viewModel.activateInventoryItem(row) },
            onChatFocusChange: { focused in viewModel.setChatInputFocused(focused) }
        )
        .onAppear { viewModel.bootstrapAutoLogin() }
        .sheet(item: $viewModel.presentedSheet) { sheet in
            switch sheet {
            case .login:
                LoginSheetView(viewModel: viewModel)
            case .registration:
                RegistrationSheetView(viewModel: viewModel)
            case .about:
                AboutView()
            case let .updateRequired(skew):
                UpdateRequiredSheetView(viewModel: viewModel, skew: skew, onCheckForUpdates: onCheckForUpdates)
            }
        }
    }
}
