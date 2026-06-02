import Foundation
import Logging
import SomnioCore
import SomnioProtocol

/// Stateless per-verb dispatch for the admin connection. Returns `nil` only for the
/// `.say("")` no-broadcast / no-response carve-out; every other variant returns a
/// non-nil response. Exhaustive on `AdminRequest` so a wire-layer addition is a
/// compile-time failure here.
public enum AdminCommandDispatcher {
    public static func handle(
        _ request: AdminRequest,
        dependencies: AdminConnectionDependencies
    ) async -> AdminResponse? {
        switch request {
        case .log:
            return readLog(
                directory: dependencies.logsDirectory,
                fileName: dependencies.gameplayLogFileName,
                emptyResponse: .logEmpty,
                contentsResponse: AdminResponse.logContents(text:),
                logger: dependencies.logger
            )
        case .weblog:
            return readLog(
                directory: dependencies.logsDirectory,
                fileName: dependencies.adminLogFileName,
                emptyResponse: .weblogEmpty,
                contentsResponse: AdminResponse.weblogContents(text:),
                logger: dependencies.logger
            )
        case .logRemove:
            removeLog(
                directory: dependencies.logsDirectory,
                fileName: dependencies.gameplayLogFileName,
                logger: dependencies.logger
            )
            return .logRemoved
        case .weblogRemove:
            removeLog(
                directory: dependencies.logsDirectory,
                fileName: dependencies.adminLogFileName,
                logger: dependencies.logger
            )
            return .weblogRemoved
        case .players:
            let count = await dependencies.worldRouter.loggedInPlayerCount()
            return .playerCount(text: String(count))
        case .time:
            let clock = await dependencies.worldClock.currentTime()
            let hour = String(format: "%02d", Int(clock.hour))
            let minute = String(format: "%02d", Int(clock.minute))
            let second = String(format: "%02d", Int(clock.second))
            let text = "\(clock.year);\(clock.month);\(clock.day);\(hour);\(minute);\(second)"
            return .worldClock(text: text)
        case let .say(text):
            guard !text.isEmpty, text.utf8.count <= SomnioProtocolConstants.maxSayUTF8Bytes else { return nil }
            await dependencies.worldRouter.broadcastToAllConnections(.adminSay(AdminSayMessage(text: text)))
            return .sayBroadcast(text: text)
        case let .kick(name):
            let kicked = await dependencies.worldRouter.kickByCharacterName(name)
            return kicked ? .kickedPlayer(text: name) : .kickedPlayerNotFound(text: name)
        case .version:
            return .versionString(text: dependencies.serverVersion)
        }
    }

    // MARK: - Helpers

    private static func readLog(
        directory: URL,
        fileName: String,
        emptyResponse: AdminResponse,
        contentsResponse: (String) -> AdminResponse,
        logger: Logger
    ) -> AdminResponse {
        let url = directory.appendingPathComponent(fileName)
        do {
            let data = try Data(contentsOf: url)
            guard let text = String(data: data, encoding: .utf8) else {
                logger.warning(
                    "admin log read returned non-UTF-8 bytes; reporting empty",
                    metadata: ["file": "\(fileName)"]
                )
                return emptyResponse
            }
            if text.isEmpty { return emptyResponse }
            return contentsResponse(truncateToWireLimit(text))
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            return emptyResponse
        } catch {
            logger.warning(
                "admin log read failed; reporting empty",
                metadata: ["error": "\(error)", "file": "\(fileName)"]
            )
            return emptyResponse
        }
    }

    private static func removeLog(directory: URL, fileName: String, logger: Logger) {
        let writer = FileLogWriter.shared(directory: directory, fileName: fileName)
        let removed = writer.closeAndRemove()
        if !removed {
            logger.debug(
                "admin log close-and-remove reported no file removed",
                metadata: ["file": "\(fileName)"]
            )
        }
    }

    /// Cap `text` to a 65535-byte UTF-8 window so a single admin log reply stays a
    /// bounded frame. Operators read log tails to diagnose recent events, so we keep the
    /// trailing window rather than the leading prefix. The UTF-8 byte position is walked
    /// forward to the next valid character boundary so we never split a multi-byte
    /// codepoint mid-sequence; UTF-8 codepoints are at most 4 bytes, so at worst three
    /// trailing bytes are dropped from a 65535-byte window.
    static func truncateToWireLimit(_ text: String) -> String {
        let limit = Int(UInt16.max)
        let utf8 = text.utf8
        guard utf8.count > limit else { return text }
        var cut = utf8.index(utf8.endIndex, offsetBy: -limit)
        var stringIndex = cut.samePosition(in: text)
        while stringIndex == nil, cut < utf8.endIndex {
            cut = utf8.index(after: cut)
            stringIndex = cut.samePosition(in: text)
        }
        guard let aligned = stringIndex else { return "" }
        return String(text[aligned...])
    }
}
