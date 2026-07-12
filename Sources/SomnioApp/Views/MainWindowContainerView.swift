import AppKit
import SomnioCore
import SomnioScene3D
import SomnioTheme
import SomnioUI
import SwiftUI

/// Hosts the full-bleed `MainWindowView`, the in-game overlay stack, the scroll-wheel
/// zoom, and the window bridge (fullscreen-at-launch + the app-wide Esc monitor). Lives
/// in the player client because it stitches together view-model state with the SomnioUI
/// composition contract. Chat focus is owned by the view model and threaded down as a
/// binding routed through `setChatInputFocused` — NOT `$viewModel.isChatInputFocused` —
/// so focus gain keeps clearing held keys on the production path.
@MainActor public struct MainWindowContainerView: View {
    @Bindable var viewModel: ClientViewModel
    /// The concrete 3D renderer, threaded in from the app entry rather than recovered from the
    /// erased `viewModel.worldScene`, because `WorldScene3DView` needs the concrete type.
    private let renderer: WorldScene3D
    private let onCheckForUpdates: () -> Void

    /// Session-only scroll zoom; a relaunch starts back at the default magnification.
    @State private var playerZoom = PlayerZoom()
    /// Mirrors `MainWindowView`'s floating-panel hover so the scroll monitor can pass
    /// wheel events through to the panels (chat scrollback) instead of zooming the world.
    @State private var isCursorOverFloatingUI = false

    public init(viewModel: ClientViewModel, renderer: WorldScene3D, onCheckForUpdates: @escaping () -> Void) {
        self._viewModel = Bindable(viewModel)
        self.renderer = renderer
        self.onCheckForUpdates = onCheckForUpdates
    }

    public var body: some View {
        GeometryReader { proxy in
            MainWindowView(
                playField: playField(size: proxy.size),
                energy: viewModel.energy,
                players: viewModel.players,
                items: viewModel.inventory,
                chatLines: viewModel.chatLines,
                chatInput: $viewModel.chatInput,
                chatFocused: chatFocusedBinding,
                onSubmitChat: { viewModel.submitChat() },
                onItemActivate: { row in viewModel.activateInventoryItem(row) },
                onFloatingUIHoverChange: { hovering in isCursorOverFloatingUI = hovering }
            )
        }
        .overlay {
            overlayHost
        }
        .background(WindowConfigurator(onEscape: { viewModel.handleEscape() }))
        .onAppear { viewModel.bootstrapAutoLogin() }
    }

    /// The world viewport at the live window size (the camera scale is size-independent,
    /// so a resize needs no framing call — only the view size updates), plus the cursor
    /// facing tracker and the zoom's scroll monitor.
    private func playField(size: CGSize) -> some View {
        ZStack {
            WorldScene3DView(scene: renderer, size: size)
                .overlay {
                    MouseFacingTrackingView { facing in viewModel.updateMouseFacing(facing) }
                }
            CanvasScrollMonitor { event in
                handleScroll(event)
            }
        }
    }

    /// Scroll-wheel zoom gate: pass the event through (not consumed) while an overlay is
    /// up or the cursor sits over floating UI — the chat scrollback then receives it —
    /// and otherwise consume it as a zoom step, holding the camera at the clamped factor.
    private func handleScroll(_ event: NSEvent) -> Bool {
        guard viewModel.presentedOverlay == nil, !isCursorOverFloatingUI else { return false }
        if playerZoom.applyScroll(deltaY: event.scrollingDeltaY) {
            renderer.applyPlayerFraming(zoomFactor: playerZoom.factor)
        }
        return true
    }

    /// Routes through `setChatInputFocused` so focus gain clears held keys (a key landing
    /// during the focus transition would otherwise survive into the next tick); this same
    /// downward channel lets `handleEscape` blur the field.
    private var chatFocusedBinding: Binding<Bool> {
        Binding(
            get: { viewModel.isChatInputFocused },
            set: { viewModel.setChatInputFocused($0) }
        )
    }

    /// The in-game modal stack: `FantasyModalHost` supplies the dimmed click-swallowing
    /// backdrop and the modal accessibility contract; this switch supplies the overlay.
    @ViewBuilder private var overlayHost: some View {
        if let overlay = viewModel.presentedOverlay {
            FantasyModalHost {
                switch overlay {
                case .login:
                    LoginOverlayView(viewModel: viewModel)
                case .registration:
                    RegistrationOverlayView(viewModel: viewModel)
                case .about:
                    AboutOverlayView(viewModel: viewModel)
                case let .updateRequired(skew):
                    UpdateRequiredOverlayView(viewModel: viewModel, skew: skew, onCheckForUpdates: onCheckForUpdates)
                case .options:
                    OptionsOverlayView(viewModel: viewModel)
                case .gameMenu:
                    GameMenuOverlayView(viewModel: viewModel)
                }
            } onEscape: {
                viewModel.handleEscape()
            }
        }
    }
}
