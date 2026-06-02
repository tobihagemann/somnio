import Foundation
import Testing
@testable import SomnioProtocol

// `AdminRequest` and `AdminResponse` ship hand-rolled `Codable` conformances dispatching
// on a string `tag` with payload-bearing variants carrying a `payload` string. Round-trips
// through `JSONEncoder` / `JSONDecoder` confirm every variant's tag and payload survive the
// wire form; the tag-string tests pin the discriminator names that the CLI and server share.

struct AdminCodableTests {
    private func roundTripRequest(_ value: AdminRequest) throws -> AdminRequest {
        let bytes = try JSONEncoder().encode(value)
        return try JSONDecoder().decode(AdminRequest.self, from: bytes)
    }

    private func roundTripResponse(_ value: AdminResponse) throws -> AdminResponse {
        let bytes = try JSONEncoder().encode(value)
        return try JSONDecoder().decode(AdminResponse.self, from: bytes)
    }

    private func tag(of value: some Encodable) throws -> String {
        let bytes = try JSONEncoder().encode(value)
        let object = try JSONSerialization.jsonObject(with: bytes) as? [String: Any]
        return object?["tag"] as? String ?? ""
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
        let bytes = Data(#"{"tag":"bogus"}"#.utf8)
        #expect(throws: SomnioProtocolError.unrecognizedTag("bogus")) {
            try JSONDecoder().decode(AdminRequest.self, from: bytes)
        }
    }

    @Test func `admin response rejects unrecognized tag`() {
        let bytes = Data(#"{"tag":"bogus"}"#.utf8)
        #expect(throws: SomnioProtocolError.unrecognizedTag("bogus")) {
            try JSONDecoder().decode(AdminResponse.self, from: bytes)
        }
    }

    @Test func `admin request tag strings are stable`() throws {
        // Pin the wire discriminator strings — renaming one would be a silent admin-channel break.
        #expect(try tag(of: AdminRequest.log) == "log")
        #expect(try tag(of: AdminRequest.weblog) == "weblog")
        #expect(try tag(of: AdminRequest.players) == "players")
        #expect(try tag(of: AdminRequest.time) == "time")
        #expect(try tag(of: AdminRequest.say(text: "")) == "say")
        #expect(try tag(of: AdminRequest.kick(name: "")) == "kick")
        #expect(try tag(of: AdminRequest.version) == "version")
        #expect(try tag(of: AdminRequest.logRemove) == "logRemove")
        #expect(try tag(of: AdminRequest.weblogRemove) == "weblogRemove")
    }

    @Test func `admin response tag strings are stable`() throws {
        // Same regression guard as the request side — admin replies live or die by these tags.
        #expect(try tag(of: AdminResponse.logContents(text: "")) == "logContents")
        #expect(try tag(of: AdminResponse.weblogContents(text: "")) == "weblogContents")
        #expect(try tag(of: AdminResponse.logEmpty) == "logEmpty")
        #expect(try tag(of: AdminResponse.logRemoved) == "logRemoved")
        #expect(try tag(of: AdminResponse.weblogEmpty) == "weblogEmpty")
        #expect(try tag(of: AdminResponse.weblogRemoved) == "weblogRemoved")
        #expect(try tag(of: AdminResponse.playerCount(text: "")) == "playerCount")
        #expect(try tag(of: AdminResponse.worldClock(text: "")) == "worldClock")
        #expect(try tag(of: AdminResponse.sayBroadcast(text: "")) == "sayBroadcast")
        #expect(try tag(of: AdminResponse.kickedPlayer(text: "")) == "kickedPlayer")
        #expect(try tag(of: AdminResponse.kickedPlayerNotFound(text: "")) == "kickedPlayerNotFound")
        #expect(try tag(of: AdminResponse.versionString(text: "")) == "versionString")
        #expect(try tag(of: AdminResponse.unknownCommand) == "unknownCommand")
    }
}
