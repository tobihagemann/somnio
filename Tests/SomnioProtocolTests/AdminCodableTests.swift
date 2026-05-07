import Foundation
import Testing
@testable import SomnioProtocol

// `AdminRequest` and `AdminResponse` ship hand-rolled `Codable` conformances dispatching
// on a leading `u8` tag with payload-bearing variants. Round-trips through `BinaryEncoder` /
// `BinaryDecoder` confirm every variant's tag and payload survive the wire form.

struct AdminCodableTests {
    private func roundTripRequest(_ value: AdminRequest) throws -> AdminRequest {
        let bytes = try BinaryEncoder().encode(value)
        return try BinaryDecoder().decode(AdminRequest.self, from: bytes)
    }

    private func roundTripResponse(_ value: AdminResponse) throws -> AdminResponse {
        let bytes = try BinaryEncoder().encode(value)
        return try BinaryDecoder().decode(AdminResponse.self, from: bytes)
    }

    @Test(arguments: [
        AdminRequest.log,
        AdminRequest.weblog,
        AdminRequest.players,
        AdminRequest.time,
        AdminRequest.say(text: "hello"),
        AdminRequest.kick(name: "Saibot"),
        AdminRequest.version,
        AdminRequest.logRemove,
        AdminRequest.weblogRemove
    ])
    func `admin request round trips`(_ request: AdminRequest) throws {
        #expect(try roundTripRequest(request) == request)
    }

    @Test(arguments: [
        AdminResponse.logContents(text: "log..."),
        AdminResponse.weblogContents(text: "web..."),
        AdminResponse.logEmpty,
        AdminResponse.logRemoved,
        AdminResponse.weblogEmpty,
        AdminResponse.weblogRemoved,
        AdminResponse.playerCount(text: "12"),
        AdminResponse.worldClock(text: "12:00"),
        AdminResponse.sayBroadcast(text: "shutdown soon"),
        AdminResponse.kickedPlayer(text: "Saibot"),
        AdminResponse.kickedPlayerNotFound(text: "Eve"),
        AdminResponse.versionString(text: "1.0.0"),
        AdminResponse.unknownCommand
    ])
    func `admin response round trips`(_ response: AdminResponse) throws {
        #expect(try roundTripResponse(response) == response)
    }

    @Test func `admin request rejects unrecognized tag`() {
        let bytes = Data([0xFF])
        #expect(throws: SomnioProtocolError.unrecognizedTag(0xFF)) {
            try BinaryDecoder().decode(AdminRequest.self, from: bytes)
        }
    }

    @Test func `admin response rejects unrecognized tag`() {
        let bytes = Data([0xFF])
        #expect(throws: SomnioProtocolError.unrecognizedTag(0xFF)) {
            try BinaryDecoder().decode(AdminResponse.self, from: bytes)
        }
    }

    @Test func `admin request tag bytes are stable`() throws {
        // Pin the wire-byte assignments — re-numbering would be a silent admin-channel break.
        #expect(try BinaryEncoder().encode(AdminRequest.log).first == 0)
        #expect(try BinaryEncoder().encode(AdminRequest.weblog).first == 1)
        #expect(try BinaryEncoder().encode(AdminRequest.players).first == 2)
        #expect(try BinaryEncoder().encode(AdminRequest.time).first == 3)
        #expect(try BinaryEncoder().encode(AdminRequest.say(text: "")).first == 4)
        #expect(try BinaryEncoder().encode(AdminRequest.kick(name: "")).first == 5)
        #expect(try BinaryEncoder().encode(AdminRequest.version).first == 6)
        #expect(try BinaryEncoder().encode(AdminRequest.logRemove).first == 7)
        #expect(try BinaryEncoder().encode(AdminRequest.weblogRemove).first == 8)
    }

    @Test func `admin response tag bytes are stable`() throws {
        // Same regression guard as the request side — admin replies live or die by these bytes.
        #expect(try BinaryEncoder().encode(AdminResponse.logContents(text: "")).first == 0)
        #expect(try BinaryEncoder().encode(AdminResponse.weblogContents(text: "")).first == 1)
        #expect(try BinaryEncoder().encode(AdminResponse.logEmpty).first == 2)
        #expect(try BinaryEncoder().encode(AdminResponse.logRemoved).first == 3)
        #expect(try BinaryEncoder().encode(AdminResponse.weblogEmpty).first == 4)
        #expect(try BinaryEncoder().encode(AdminResponse.weblogRemoved).first == 5)
        #expect(try BinaryEncoder().encode(AdminResponse.playerCount(text: "")).first == 6)
        #expect(try BinaryEncoder().encode(AdminResponse.worldClock(text: "")).first == 7)
        #expect(try BinaryEncoder().encode(AdminResponse.sayBroadcast(text: "")).first == 8)
        #expect(try BinaryEncoder().encode(AdminResponse.kickedPlayer(text: "")).first == 9)
        #expect(try BinaryEncoder().encode(AdminResponse.kickedPlayerNotFound(text: "")).first == 10)
        #expect(try BinaryEncoder().encode(AdminResponse.versionString(text: "")).first == 11)
        #expect(try BinaryEncoder().encode(AdminResponse.unknownCommand).first == 12)
    }
}
