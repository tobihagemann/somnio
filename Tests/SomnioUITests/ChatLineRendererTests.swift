import Foundation
import Testing
@testable import SomnioUI

struct ChatLineRendererTests {
    private let en = Locale(identifier: "en_US")

    @Test func `own message with statement verb`() {
        let line = ChatLine.spokenByOwn(senderName: "Saibot", message: "Hello.")
        #expect(ChatLineRenderer.render(line, locale: en) == "Saibot says, \"Hello.\"")
    }

    @Test func `own message with question verb`() {
        let line = ChatLine.spokenByOwn(senderName: "Saibot", message: "Hello?")
        #expect(ChatLineRenderer.render(line, locale: en) == "Saibot asks, \"Hello?\"")
    }

    @Test func `own message with exclamation verb`() {
        let line = ChatLine.spokenByOwn(senderName: "Saibot", message: "Hello!")
        #expect(ChatLineRenderer.render(line, locale: en) == "Saibot exclaims, \"Hello!\"")
    }

    @Test func `peer message uses the same verb templates as own messages`() {
        let line = ChatLine.spokenByPeer(senderName: "Libus", message: "Greetings!")
        #expect(ChatLineRenderer.render(line, locale: en) == "Libus exclaims, \"Greetings!\"")
    }

    @Test func `npc message uses the same verb templates as own messages`() {
        let line = ChatLine.spokenByNPC(senderName: "Wizard", message: "Are you ready?")
        #expect(ChatLineRenderer.render(line, locale: en) == "Wizard asks, \"Are you ready?\"")
    }

    @Test func `admin broadcast renders the framing template`() {
        let line = ChatLine.adminBroadcast(message: "Server restarting in 5 minutes.")
        #expect(ChatLineRenderer.render(line, locale: en) == "Broadcast message: Server restarting in 5 minutes.")
    }

    @Test func `connection lost renders the localized notice`() {
        #expect(ChatLineRenderer.render(.connectionLost, locale: en) == "The connection was lost.")
    }

    @Test func `server unreachable renders the localized notice`() {
        #expect(ChatLineRenderer.render(.serverUnreachable, locale: en) == "The server is currently not reachable. Try again later.")
    }

    @Test func `error code substitutes the code`() {
        #expect(ChatLineRenderer.render(.errorCode(code: "42"), locale: en) == "Error 42 occurred.")
    }

    @Test func `joined substitutes the player name`() {
        #expect(ChatLineRenderer.render(.joined(playerName: "Saibot"), locale: en) == "Saibot entered the game.")
    }

    @Test func `left substitutes the player name`() {
        #expect(ChatLineRenderer.render(.left(playerName: "Saibot"), locale: en) == "Saibot left the game.")
    }

    @Test func `startup greeting renders the welcome line`() {
        #expect(ChatLineRenderer.render(.startupGreeting, locale: en) == "Welcome to Somnio!")
    }
}
