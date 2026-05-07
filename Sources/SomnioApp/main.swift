import Foundation
import Logging
import SomnioCore

// Placeholder entry point for the player client. The full SwiftUI app — splash, login,
// world view, WebSocket connection — lands in a later iteration. For now we just bootstrap
// the logging system so the dev/prod isolation paths are exercisable.

LoggingConfiguration.bootstrap()
let lifecycleLog = Logger(label: "de.tobiha.somnio.app.lifecycle")
lifecycleLog.info("SomnioApp placeholder bootstrap")
