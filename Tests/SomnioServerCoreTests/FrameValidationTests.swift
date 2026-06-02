import Foundation
import SomnioProtocol
import Testing

/// Decoder failure-mode coverage for the inbound paths the connection actor's terminal-close
/// path catches. A `SomnioProtocolError.unrecognizedTag` flows through the actor's
/// `SomnioProtocolError` catch; a `Swift.DecodingError` from malformed JSON flows through its
/// generic catch — both end in `.close(.protocolError, ...)`. Binary-frame rejection and the
/// `maxFrameSize` oversize close are exercised end-to-end in the integration suite.
struct FrameValidationTests {
    @Test func `malformed JSON text surfaces a decoding error`() {
        let bytes = Data(#"{ not json "#.utf8)
        #expect(throws: DecodingError.self) {
            _ = try SomnioMessageDecoder.decode(bytes)
        }
    }

    @Test func `unknown string tag surfaces unrecognizedTag with the offending tag`() {
        let bytes = Data(#"{"tag":"notAVerb","payload":{}}"#.utf8)
        #expect(throws: SomnioProtocolError.unrecognizedTag("notAVerb")) {
            _ = try SomnioMessageDecoder.decode(bytes)
        }
    }

    @Test func `valid JSON missing the payload surfaces a decoding error`() {
        // A recognized tag whose payload is absent must not silently decode — the keyed
        // container decode for the payload throws, closing the connection.
        let bytes = Data(#"{"tag":"login"}"#.utf8)
        #expect(throws: DecodingError.self) {
            _ = try SomnioMessageDecoder.decode(bytes)
        }
    }
}
