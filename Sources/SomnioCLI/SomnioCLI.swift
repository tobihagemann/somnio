import ArgumentParser
import Foundation
import Logging
import SomnioCore

@main
struct SomnioCLITool: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "somniocli",
        abstract: "Somnio admin CLI.",
        subcommands: [],
        defaultSubcommand: nil
    )

    func run() async throws {
        // Placeholder entry point for the admin CLI. Verb dispatch (`log`, `weblog`,
        // `players`, `time`, `say`, `kick`, `version`, `log rm`, `weblog rm`) lands in a
        // later iteration. For now we just bootstrap logging so packaging has a runnable
        // binary.
        LoggingConfiguration.bootstrap()
        let lifecycleLog = Logger(label: "de.tobiha.somnio.cli.lifecycle")
        lifecycleLog.info("somniocli placeholder bootstrap")
    }
}
