import Logging
import SomnioCore
import SomnioScene3D
import Sparkle
import SwiftUI

/// `@main` shim. Cannot live in a file literally named `main.swift` (SwiftPM treats
/// those as top-level entry points and `@main` is forbidden). The app declares a single
/// resizable `Window` (fullscreen-first via `WindowConfigurator`); every dialog surface
/// — including Join/Leave (the Esc game menu) and the app options — is an in-game
/// overlay, so the menu bar carries only "About Somnio" (opening the overlay) and
/// Sparkle's "Check for Updates...", with no `Settings` scene.
@main
struct SomnioAppEntry: App {
    @State private var viewModel: ClientViewModel
    /// The concrete 3D renderer is retained here too: the view model drives it through the erased
    /// `any WorldRenderSurface` seam, but the host view needs the concrete `WorldScene3D` to vend
    /// its `RealityView` content, so the app entry threads the same instance to both. SwiftUI
    /// instantiates the `@main` App once per process, so this `let` and the renderer captured in
    /// `viewModel` stay the same object.
    private let renderer: WorldScene3D
    private let updaterController: SPUStandardUpdaterController

    init() {
        LoggingConfiguration.bootstrap()
        let lifecycleLog = Logger(label: "de.tobiha.somnio.app.lifecycle")
        lifecycleLog.info("SomnioApp launching")
        let renderer = WorldScene3D()
        self.renderer = renderer
        _viewModel = State(initialValue: ClientViewModel(worldScene: renderer))
        // Warm the model cache before the first connect — the fixed cast is small, so the
        // common path never shows placeholders; anything placed before this finishes is
        // re-resolved in place when it completes.
        Task {
            await renderer.prewarmModels()
        }
        self.updaterController = SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: nil,
            userDriverDelegate: nil
        )
    }

    var body: some Scene {
        Window(L.resource("Somnio"), id: "main") {
            MainWindowContainerView(
                viewModel: viewModel,
                renderer: renderer,
                onCheckForUpdates: { updaterController.checkForUpdates(nil) }
            )
            .frame(minWidth: 1024, minHeight: 640)
        }
        .windowResizability(.contentMinSize)
        .defaultSize(width: 1440, height: 900)
        .windowStyle(.titleBar)
        .commands {
            CommandGroup(replacing: .appInfo) {
                Button {
                    viewModel.presentedOverlay = .about
                } label: {
                    Text(L.resource("About Somnio"))
                }
            }
            CommandGroup(after: .appSettings) {
                Button {
                    updaterController.checkForUpdates(nil)
                } label: {
                    Text(L.resource("Check for Updates..."))
                }
            }
            // Strip File > New Window — a second world window makes no sense for the game.
            CommandGroup(replacing: .newItem) {}
            CommandGroup(replacing: .help) {}
        }
    }
}
