import SomnioCore
import SomnioUI
import SwiftUI

/// Hosts `MainWindowView` plus the modal sheet stack and the chat-input focus
/// bridge. Lives in the player client because it stitches together view-model state
/// with the SomnioUI composition contract. The focus state is owned by
/// `ChatInputView` (which holds the `@FocusState` next to the actual `TextField`)
/// and reported here through the `onChatFocusChange` callback.
@MainActor public struct MainWindowContainerView: View {
    @Bindable var viewModel: ClientViewModel

    public init(viewModel: ClientViewModel) {
        self._viewModel = Bindable(viewModel)
    }

    public var body: some View {
        MainWindowView(
            playField: WorldSceneView(scene: viewModel.worldScene),
            energy: viewModel.energy,
            players: viewModel.players,
            items: viewModel.inventory,
            chatLines: viewModel.chatLines,
            chatInput: $viewModel.chatInput,
            onSubmitChat: { viewModel.submitChat() },
            onItemTap: { row, hand in viewModel.toggleEquip(row, hand: hand) },
            onChatFocusChange: { focused in viewModel.isChatInputFocused = focused }
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
            }
        }
    }
}
