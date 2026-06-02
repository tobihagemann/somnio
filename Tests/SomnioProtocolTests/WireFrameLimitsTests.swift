import Foundation
import Testing
@testable import SomnioProtocol

/// Pins the wire-contract invariants that the JSON round-trip tests cannot catch: the gameplay
/// tag discriminator strings (a rename would round-trip green yet break a deployed peer), the
/// encoder's outbound `oversizedFrame` guard, and the `maxWireFrameSize` headroom that lets that
/// guard fire before the receiver's `maxFrameSize` hard close.
struct WireFrameLimitsTests {
    @Test func `gameplay tag strings are stable`() {
        // Renaming a case renames both encode and decode sides at once, so a round-trip stays
        // green while a running older peer can no longer parse the `"tag"`. Pin each string.
        #expect(SomnioMessageTag.login.rawValue == "login")
        #expect(SomnioMessageTag.register.rawValue == "register")
        #expect(SomnioMessageTag.clientPosition.rawValue == "clientPosition")
        #expect(SomnioMessageTag.clientSay.rawValue == "clientSay")
        #expect(SomnioMessageTag.equipToggle.rawValue == "equipToggle")
        #expect(SomnioMessageTag.bumpNPC.rawValue == "bumpNPC")
        #expect(SomnioMessageTag.enterPortal.rawValue == "enterPortal")
        #expect(SomnioMessageTag.hello.rawValue == "hello")
        #expect(SomnioMessageTag.loginResult.rawValue == "loginResult")
        #expect(SomnioMessageTag.registerResult.rawValue == "registerResult")
        #expect(SomnioMessageTag.enterSector.rawValue == "enterSector")
        #expect(SomnioMessageTag.mainCharacter.rawValue == "mainCharacter")
        #expect(SomnioMessageTag.entity.rawValue == "entity")
        #expect(SomnioMessageTag.serverPosition.rawValue == "serverPosition")
        #expect(SomnioMessageTag.serverSay.rawValue == "serverSay")
        #expect(SomnioMessageTag.energy.rawValue == "energy")
        #expect(SomnioMessageTag.dateTick.rawValue == "dateTick")
        #expect(SomnioMessageTag.inventory.rawValue == "inventory")
        #expect(SomnioMessageTag.leave.rawValue == "leave")
        #expect(SomnioMessageTag.adminSay.rawValue == "adminSay")
        // Guards against a new case landing without a stability pin above.
        #expect(SomnioMessageTag.allCases.count == 20)
    }

    @Test func `encoder rejects a message larger than maxFrameLength`() throws {
        let oversized = String(repeating: "x", count: Int(SomnioProtocolConstants.maxFrameLength) + 1)
        let message = SomnioMessage.adminSay(AdminSayMessage(text: oversized))
        do {
            _ = try SomnioMessageEncoder.encode(message)
            Issue.record("expected SomnioProtocolError.oversizedFrame")
        } catch let SomnioProtocolError.oversizedFrame(size) {
            #expect(size > SomnioProtocolConstants.maxFrameLength)
        }
    }

    @Test func `a max-bounded message encodes without tripping the guard`() throws {
        let message = SomnioMessage.adminSay(AdminSayMessage(text: "well within bounds"))
        let frame = try SomnioMessageEncoder.encode(message)
        #expect(frame.count <= Int(SomnioProtocolConstants.maxFrameLength))
    }

    @Test func `the WS frame ceiling sits strictly above the encoder guard`() {
        #expect(SomnioProtocolConstants.maxWireFrameSize > Int(SomnioProtocolConstants.maxFrameLength))
    }
}
