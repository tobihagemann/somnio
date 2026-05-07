import Foundation
import Logging

// Placeholder entry point for the gameplay server. The Hummingbird WebSocket service,
// swift-service-lifecycle wiring, AI ticks, and admin handler land in later iterations.
// For now we just bootstrap the three-handler logging system (stdout JSON + gameplay-
// label-filtered file backend + admin-label-filtered file backend) and emit test loggers
// so the routing is inspectable from each output stream.

ServerLoggingConfiguration.bootstrap()

let gameplayLog = Logger(label: "de.tobiha.somnio.server.gameplay.test")
let adminLog = Logger(label: "de.tobiha.somnio.server.admin.test")
let lifecycleLog = Logger(label: "de.tobiha.somnio.server.lifecycle.test")

gameplayLog.info("SomnioServer: gameplay test line")
adminLog.info("SomnioServer: admin test line")
lifecycleLog.info("SomnioServer: lifecycle test line")
