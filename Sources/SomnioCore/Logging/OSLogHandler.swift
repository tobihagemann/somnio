#if canImport(OSLog)
    import Logging
    import os

    private typealias OSLogger = os.Logger

    /// A swift-log `LogHandler` that forwards messages to Apple's unified logging system via
    /// `os.Logger`. Parses the logger label to derive an OSLog subsystem and category:
    /// `"de.tobiha.somnio.app.lifecycle"` → subsystem `"de.tobiha.somnio.app"`,
    /// category `"lifecycle"`.
    public struct OSLogHandler: LogHandler {
        private let osLogger: OSLogger

        public var logLevel: Logging.Logger.Level = .trace
        public var metadata: Logging.Logger.Metadata = [:]
        public var metadataProvider: Logging.Logger.MetadataProvider?

        public init(label: String) {
            let (subsystem, category) = Self.parseLabel(label)
            self.osLogger = OSLogger(subsystem: subsystem, category: category)
        }

        public func log(event: LogEvent) {
            // Privacy is left at OSLog's default (`.private` for dynamic interpolations) so
            // user-controllable values — chat, character names, account identifiers — don't
            // surface in Console.app or sysdiagnose archives. Static fields like log labels
            // remain visible because they aren't interpolated.
            let merged = LogMetadata.merged(
                handler: metadata,
                provider: metadataProvider?.get(),
                event: event.metadata
            )
            let msg = event.message.description
                + LogMetadata.flatTextSuffix(merged: merged, error: event.error)
            switch event.level {
            case .trace, .debug:
                osLogger.debug("\(msg)")
            case .info:
                osLogger.info("\(msg)")
            case .notice:
                osLogger.notice("\(msg)")
            case .warning:
                osLogger.warning("\(msg)")
            case .error:
                osLogger.error("\(msg)")
            case .critical:
                osLogger.fault("\(msg)")
            }
        }

        public subscript(metadataKey key: String) -> Logging.Logger.Metadata.Value? {
            get { metadata[key] }
            set { metadata[key] = newValue }
        }

        // MARK: - Label Parsing

        /// Splits `"de.tobiha.somnio.app.lifecycle"` into `("de.tobiha.somnio.app", "lifecycle")`.
        /// Falls back to the full label for both subsystem and category if no dot is found.
        static func parseLabel(_ label: String) -> (subsystem: String, category: String) {
            guard let lastDot = label.lastIndex(of: ".") else {
                return (label, label)
            }
            let subsystem = String(label[label.startIndex ..< lastDot])
            let category = String(label[label.index(after: lastDot)...])
            return (subsystem, category)
        }
    }
#endif
