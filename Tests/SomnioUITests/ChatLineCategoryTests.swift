import Testing
@testable import SomnioUI

struct ChatLineCategoryTests {
    @Test(arguments: [
        (ChatLine.spokenByOwn(senderName: "x", message: "x"), ChatLineCategory.ownMessage),
        (ChatLine.spokenByPeer(senderName: "x", message: "x"), ChatLineCategory.peerMessage),
        (ChatLine.spokenByNPC(senderName: "x", message: "x"), ChatLineCategory.npcMessage),
        (ChatLine.adminBroadcast(message: "x"), ChatLineCategory.adminBroadcast),
        (ChatLine.connectionLost, ChatLineCategory.error),
        (ChatLine.serverUnreachable, ChatLineCategory.error),
        (ChatLine.badCredentials, ChatLineCategory.error),
        (ChatLine.alreadyLoggedIn, ChatLineCategory.error),
        (ChatLine.errorCode(code: "1"), ChatLineCategory.error),
        (ChatLine.joined(playerName: "x"), ChatLineCategory.joinLeave),
        (ChatLine.left(playerName: "x"), ChatLineCategory.joinLeave),
        (ChatLine.startupGreeting, ChatLineCategory.startupGreeting)
    ])
    func category(line: ChatLine, expected: ChatLineCategory) {
        #expect(line.category == expected)
    }
}
