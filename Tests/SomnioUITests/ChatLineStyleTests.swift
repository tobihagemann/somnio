import Testing
@testable import SomnioUI

struct ChatLineStyleTests {
    @Test(arguments: [
        (ChatLineCategory.ownMessage, ChatLineStyle(foreground: .purple, bold: false, italic: false)),
        (ChatLineCategory.peerMessage, ChatLineStyle(foreground: .primary, bold: false, italic: false)),
        (ChatLineCategory.npcMessage, ChatLineStyle(foreground: .primary, bold: false, italic: false)),
        (ChatLineCategory.adminBroadcast, ChatLineStyle(foreground: .red, bold: false, italic: false)),
        (ChatLineCategory.error, ChatLineStyle(foreground: .red, bold: false, italic: false)),
        (ChatLineCategory.joinLeave, ChatLineStyle(foreground: .blue, bold: false, italic: true)),
        (ChatLineCategory.startupGreeting, ChatLineStyle(foreground: .blue, bold: false, italic: true)),
        (ChatLineCategory.itemInfo, ChatLineStyle(foreground: .primary, bold: false, italic: false))
    ])
    func style(category: ChatLineCategory, expected: ChatLineStyle) {
        #expect(ChatLineStyle.style(for: category) == expected)
    }
}
