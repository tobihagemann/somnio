import Logging
import SomnioCore
import SomnioUI
import Sparkle
import SwiftUI

/// `@main` shim. Cannot live in a file literally named `main.swift` (SwiftPM treats
/// those as top-level entry points and `@main` is forbidden). The app declares a
/// single fixed-size `Window` plus a `Settings` scene; the `Commands` group registers
/// the legacy menu inventory plus Sparkle's "Check for Updates...".
@main
struct SomnioAppEntry: App {
    @State private var viewModel: ClientViewModel
    private let updaterController: SPUStandardUpdaterController

    init() {
        LoggingConfiguration.bootstrap()
        let lifecycleLog = Logger(label: "de.tobiha.somnio.app.lifecycle")
        lifecycleLog.info("SomnioApp launching")
        let assets = BundleMainSpriteAssets()
        let scene = WorldScene(size: CGSize(width: 640, height: 480), assets: assets)
        _viewModel = State(initialValue: ClientViewModel(worldScene: scene))
        self.updaterController = SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: nil,
            userDriverDelegate: nil
        )
    }

    var body: some Scene {
        Window(L.resource("Somnio"), id: "main") {
            MainWindowContainerView(viewModel: viewModel, onCheckForUpdates: { updaterController.checkForUpdates(nil) })
        }
        .windowResizability(.contentSize)
        .windowStyle(.titleBar)
        .commands {
            CommandGroup(replacing: .appInfo) {
                Button {
                    viewModel.presentedSheet = .about
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
            CommandGroup(replacing: .newItem) {
                Button {
                    viewModel.presentedSheet = .login
                } label: {
                    Text(L.resource("Join Game..."))
                }
                .keyboardShortcut("j")
                Button {
                    viewModel.leaveGame()
                } label: {
                    Text(L.resource("Leave Game"))
                }
                .keyboardShortcut("l")
                .disabled(viewModel.connectionState != .attached)
            }
            CommandGroup(replacing: .help) {}
        }

        Settings {
            PreferencesView()
        }
    }
}
