import Foundation
import Logging
import SomnioProtocol

extension ConnectionOutbox {
    /// Encode `message` and enqueue the resulting frame; on encode failure log the warning
    /// and continue. Used by every handler that emits a single response frame so the
    /// swallow-and-continue policy lives in one place.
    func sendEncoded(_ message: SomnioMessage, logger: Logger) {
        do {
            try send(SomnioMessageEncoder.encode(message))
        } catch {
            logger.warning("failed to encode response", metadata: ["error": "\(error)"])
        }
    }
}
