import Foundation
import Logging
import SomnioCore

// Placeholder entry point for the map editor. The full SwiftUI document-based app lands in
// a later iteration. For now we just bootstrap the logging system so packaging integrators
// have a runnable bundle to verify the wiring.

LoggingConfiguration.bootstrap()
let lifecycleLog = Logger(label: "de.tobiha.somnio.editor.lifecycle")
lifecycleLog.info("SomnioEditor placeholder bootstrap")
